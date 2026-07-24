//! Gree UDP payload encryption. Two ciphers with runtime version fallback:
//! bind attempt 1 uses AES-128-ECB (legacy modules), attempt 2 switches to
//! AES-128-GCM (newer Qualcomm modules). On `bindok` the device-specific key
//! replaces the generic key on the active cipher.

use crate::error::{Error, Result};
use base64::{
    alphabet,
    engine::{general_purpose::STANDARD, GeneralPurpose, GeneralPurposeConfig},
    Engine as _,
};

// GREE's Wi-Fi firmware base64-encodes GCM tags (and occasionally packs) with
// non-zero trailing bits — non-canonical per RFC 4648 §3.5. base64 0.22 rejects
// that by default (`InvalidLastSymbol`, e.g. a tag ending `…TO/n==` where a
// canonical encoder emits `…TO/g==`); the 0.13 release used before decoded it
// silently, which is why the bind handshake broke on the upgrade. Decode inbound
// payloads leniently so a stray low bit in the final symbol can't fail a bind.
// Encoding stays canonical via `STANDARD`.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

const ECB_GENERIC_KEY: &[u8; 16] = b"a3K8Bx%2r8Y7#xDh";
const GCM_GENERIC_KEY: &[u8; 16] = b"{yxAHAY_Lm6pbC/<";
// SECURITY: this nonce is fixed and reused for every GCM message under a given
// key. Static-nonce AES-GCM is normally a critical flaw (it enables forgery and
// auth-key recovery). It is NOT ours to fix — the Gree/EWPE firmware hard-codes
// this exact nonce and AAD, so matching them is required for interoperability.
// Do not randomize: it will break communication with the device.
const GCM_NONCE: [u8; 12] = [
    0x54, 0x40, 0x78, 0x44, 0x49, 0x67, 0x5a, 0x51, 0x6c, 0x5e, 0x63, 0x13,
];
const GCM_AAD: &[u8] = b"qualcomm-test";

fn set_key_16(dst: &mut [u8; 16], key: &[u8]) -> Result<()> {
    if 16 != key.len() {
        return Err(Error::Decrypt);
    }
    dst.copy_from_slice(key);
    Ok(())
}

struct EcbCipher {
    key: [u8; 16],
}

impl EcbCipher {
    fn new() -> Self {
        Self { key: *ECB_GENERIC_KEY }
    }

    fn set_key(&mut self, key: &[u8]) -> Result<()> {
        set_key_16(&mut self.key, key)
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<(String, Option<String>)> {
        use aes::Aes128;
        use cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyInit};
        use ecb::Encryptor;

        let enc =
            Encryptor::<Aes128>::new_from_slice(&self.key).map_err(|_| Error::Encrypt)?;
        let ciphertext = enc.encrypt_padded_vec_mut::<Pkcs7>(plaintext);
        Ok((STANDARD.encode(ciphertext), None))
    }

    fn decrypt(&self, pack_b64: &str, _tag_b64: Option<&str>) -> Result<Vec<u8>> {
        use aes::Aes128;
        use cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyInit};
        use ecb::Decryptor;

        let ciphertext = LENIENT.decode(pack_b64)?;
        let dec =
            Decryptor::<Aes128>::new_from_slice(&self.key).map_err(|_| Error::Decrypt)?;
        dec.decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
            .map_err(|_| Error::Decrypt)
    }
}

struct GcmCipher {
    key: [u8; 16],
}

impl GcmCipher {
    fn new() -> Self {
        Self { key: *GCM_GENERIC_KEY }
    }

    fn set_key(&mut self, key: &[u8]) -> Result<()> {
        set_key_16(&mut self.key, key)
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<(String, Option<String>)> {
        use aes_gcm::aead::{AeadInPlace, KeyInit};
        use aes_gcm::{Aes128Gcm, Nonce};

        let cipher =
            Aes128Gcm::new_from_slice(&self.key).map_err(|_| Error::Encrypt)?;
        let nonce = Nonce::from_slice(&GCM_NONCE);

        let mut buffer = plaintext.to_vec();
        let tag = cipher
            .encrypt_in_place_detached(nonce, GCM_AAD, &mut buffer)
            .map_err(|_| Error::Encrypt)?;

        Ok((STANDARD.encode(&buffer), Some(STANDARD.encode(tag.as_slice()))))
    }

    fn decrypt(&self, pack_b64: &str, tag_b64: Option<&str>) -> Result<Vec<u8>> {
        use aes_gcm::aead::{AeadInPlace, KeyInit};
        use aes_gcm::{Aes128Gcm, Nonce, Tag};

        let cipher =
            Aes128Gcm::new_from_slice(&self.key).map_err(|_| Error::Decrypt)?;
        let nonce = Nonce::from_slice(&GCM_NONCE);

        let mut buffer = LENIENT.decode(pack_b64)?;
        let tag_bytes = LENIENT.decode(tag_b64.ok_or(Error::Decrypt)?)?;
        // The socket hears the whole broadcast domain, so the tag length is
        // attacker-controlled. `Tag::from_slice` asserts len == 16 and would
        // panic — with panic=abort that takes down the entire daemon.
        if tag_bytes.len() != 16 {
            return Err(Error::Decrypt);
        }
        let tag = Tag::from_slice(&tag_bytes);

        cipher
            .decrypt_in_place_detached(nonce, GCM_AAD, &mut buffer, tag)
            .map_err(|_| Error::Decrypt)?;
        Ok(buffer)
    }
}

enum Active {
    Ecb,
    Gcm,
}

/// Stateful encryptor mirroring the JS EncryptionService: it tracks bind
/// attempts and flips ECB -> GCM on the second bind, and absorbs the device
/// key from a `bindok` payload.
pub struct EncryptionService {
    ecb: EcbCipher,
    gcm: GcmCipher,
    active: Active,
    bind_attempt: u32,
}

impl EncryptionService {
    pub fn new() -> Self {
        Self {
            ecb: EcbCipher::new(),
            gcm: GcmCipher::new(),
            active: Active::Ecb,
            bind_attempt: 1,
        }
    }

    /// Encrypt an already-serialized inner message. `is_bind` drives the
    /// version-fallback counter.
    pub fn encrypt(
        &mut self,
        plaintext: &[u8],
        is_bind: bool,
    ) -> Result<(String, Option<String>)> {
        if is_bind {
            if 2 == self.bind_attempt {
                self.active = Active::Gcm;
            }
            self.bind_attempt += 1;
        }

        match self.active {
            Active::Ecb => self.ecb.encrypt(plaintext),
            Active::Gcm => self.gcm.encrypt(plaintext),
        }
    }

    /// Decrypt an inbound pack. Side effect: on `bindok`, the device key is
    /// installed on the active cipher.
    pub fn decrypt(
        &mut self,
        pack_b64: &str,
        tag_b64: Option<&str>,
    ) -> Result<serde_json::Value> {
        let bytes = match self.active {
            Active::Ecb => self.ecb.decrypt(pack_b64, tag_b64)?,
            Active::Gcm => self.gcm.decrypt(pack_b64, tag_b64)?,
        };

        let payload: serde_json::Value = serde_json::from_slice(&bytes)?;

        if Some("bindok") == payload.get("t").and_then(serde_json::Value::as_str) {
            if let Some(key) = payload.get("key").and_then(serde_json::Value::as_str) {
                match self.active {
                    Active::Ecb => self.ecb.set_key(key.as_bytes())?,
                    Active::Gcm => self.gcm.set_key(key.as_bytes())?,
                }
            }
        }

        Ok(payload)
    }
}

impl Default for EncryptionService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known-answer vectors lifted verbatim from the upstream JS test suite
    // (test/aes.spec.js). If these pass, the wire format is byte-compatible.

    const BIND_PLAINTEXT: &str = r#"{"mac":"-CLIENT-ID-","t":"bind","uid":0}"#;
    const DEVICE_KEY: &str = "---BINDED-KEY---";

    #[test]
    fn ecb_bind_request_matches_js() {
        let (pack, tag) = EcbCipher::new().encrypt(BIND_PLAINTEXT.as_bytes()).unwrap();
        assert_eq!(
            pack,
            "ddMD+/erG3STAZvk6iV1oJxrMo6m/1rGE7RiuotePqdcAeWW/XDtzpfgvpySqWVy"
        );
        assert!(tag.is_none());
    }

    #[test]
    fn gcm_bind_request_matches_js() {
        let (pack, tag) = GcmCipher::new().encrypt(BIND_PLAINTEXT.as_bytes()).unwrap();
        assert_eq!(pack, "JtoT1XUt89L+xbD+HwchGuYFpcEOwFPkOkY2VLSPhOTTY2QLz1tuNw==");
        assert_eq!(tag.as_deref(), Some("nLD1n6lnA33dk/0u9V2siQ=="));
    }

    #[test]
    fn ecb_roundtrip_with_device_key() {
        let mut c = EcbCipher::new();
        c.set_key(DEVICE_KEY.as_bytes()).unwrap();
        let (pack, _) = c.encrypt(BIND_PLAINTEXT.as_bytes()).unwrap();
        let back = c.decrypt(&pack, None).unwrap();
        assert_eq!(back, BIND_PLAINTEXT.as_bytes());
    }

    #[test]
    fn gcm_roundtrip_with_device_key() {
        let mut c = GcmCipher::new();
        c.set_key(DEVICE_KEY.as_bytes()).unwrap();
        let (pack, tag) = c.encrypt(BIND_PLAINTEXT.as_bytes()).unwrap();
        let back = c.decrypt(&pack, tag.as_deref()).unwrap();
        assert_eq!(back, BIND_PLAINTEXT.as_bytes());
    }

    #[test]
    fn gcm_wrong_length_tag_is_an_error_not_a_panic() {
        // Any LAN host can land a datagram on the daemon's broadcast socket,
        // so the tag length is untrusted input. It must surface as a Decrypt
        // error — an unchecked Tag::from_slice would assert, and with the
        // release profile's panic=abort that aborts the whole daemon.
        let mut c = GcmCipher::new();
        c.set_key(DEVICE_KEY.as_bytes()).unwrap();
        let (pack, _) = c.encrypt(BIND_PLAINTEXT.as_bytes()).unwrap();
        assert!(c.decrypt(&pack, Some("AA==")).is_err(), "1-byte tag");
        assert!(c.decrypt(&pack, Some("")).is_err(), "empty tag");
        assert!(
            c.decrypt(&pack, Some("nLD1n6lnA33dk/0u9V2siZ4=")).is_err(),
            "17-byte tag"
        );
    }

    #[test]
    fn lenient_decode_accepts_noncanonical_firmware_tag() {
        // A real GCM auth tag emitted by the Toyotomi Umi (firmware v1.45) on a
        // `bindok`. Its final symbol `n` carries non-zero trailing bits, so the
        // strict STANDARD engine rejects it with InvalidLastSymbol — the exact
        // failure that made every GCM bind time out after the base64 0.22 bump.
        // The bridge must decode it (dropping the stray bits) to the 16-byte tag.
        let tag = "t+pg0D+w5DBXJqdVW/TO/n==";
        assert!(
            STANDARD.decode(tag).is_err(),
            "strict decode is expected to reject the firmware's non-canonical tag"
        );
        assert_eq!(
            LENIENT.decode(tag).expect("lenient decode must accept it").len(),
            16,
            "a GCM tag is 16 bytes"
        );
        // The dropped trailing bits mean the non-canonical `…/n==` and the
        // canonical `…/g==` decode to the identical tag, so GCM auth still passes.
        assert_eq!(LENIENT.decode(tag).unwrap(), STANDARD.decode("t+pg0D+w5DBXJqdVW/TO/g==").unwrap());
    }

    #[test]
    fn service_bind_fallback_order() {
        // attempt 1 -> ECB, attempt 2 -> GCM, matching the JS counter.
        let mut svc = EncryptionService::new();
        let (ecb_pack, ecb_tag) = svc.encrypt(BIND_PLAINTEXT.as_bytes(), true).unwrap();
        assert_eq!(
            ecb_pack,
            "ddMD+/erG3STAZvk6iV1oJxrMo6m/1rGE7RiuotePqdcAeWW/XDtzpfgvpySqWVy"
        );
        assert!(ecb_tag.is_none());

        let (gcm_pack, gcm_tag) = svc.encrypt(BIND_PLAINTEXT.as_bytes(), true).unwrap();
        assert_eq!(
            gcm_pack,
            "JtoT1XUt89L+xbD+HwchGuYFpcEOwFPkOkY2VLSPhOTTY2QLz1tuNw=="
        );
        assert_eq!(gcm_tag.as_deref(), Some("nLD1n6lnA33dk/0u9V2siQ=="));
    }
}

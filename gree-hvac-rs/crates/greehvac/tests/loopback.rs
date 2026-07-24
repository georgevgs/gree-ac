//! End-to-end test of the connection state machine against a stand-in device on
//! loopback: scan -> bind -> bindok -> status -> cmd, over both ciphers.
//!
//! The unit tests in `crypto` prove the ciphertext is byte-identical to the JS
//! library's. This proves the *sequence* around it: that a bind is answered,
//! that the device key replaces the generic one afterwards, that a `dat` reply
//! lands in the property map with the sensor offsets applied, and that a `cmd`
//! is both encoded correctly and confirmed. The GCM case is the one the
//! Toyotomi Umi's v1.45 firmware actually takes — it ignores the first (ECB)
//! bind, and the client is supposed to retry in GCM.
//!
//! The stand-in encrypts with the `aes`/`ecb`/`aes-gcm` crates directly rather
//! than through `greehvac`'s own crypto module, so a mistake in that module
//! cannot cancel itself out here.

use std::collections::BTreeMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use greehvac::property::Property;
use greehvac::{Client, ClientConfig, Event};

const ECB_GENERIC_KEY: &[u8; 16] = b"a3K8Bx%2r8Y7#xDh";
const GCM_GENERIC_KEY: &[u8; 16] = b"{yxAHAY_Lm6pbC/<";
const DEVICE_KEY: &[u8; 16] = b"St8Vw1Yz4Bc7Ed5G";
const GCM_NONCE: [u8; 12] = [
    0x54, 0x40, 0x78, 0x44, 0x49, 0x67, 0x5a, 0x51, 0x6c, 0x5e, 0x63, 0x13,
];
const GCM_AAD: &[u8] = b"qualcomm-test";

#[derive(Clone, Copy, PartialEq)]
enum Cipher {
    Ecb,
    Gcm,
}

/// How the stand-in answers the bind. `IgnoreFirstBind` reproduces a v1.45
/// module: silence on the ECB attempt, then a GCM conversation. `NoisyLan`
/// prefixes every reply with junk, standing in for another Gree device's
/// broadcast landing on our socket. `EmptyCid` sends the dev pack most EWPE
/// units actually send — `"cid":""` with the id only in `mac`.
#[derive(Clone, Copy, PartialEq)]
enum Firmware {
    Ecb,
    IgnoreFirstBind,
    NoisyLan,
    EmptyCid,
}

const DEVICE_ID: &str = "f4911e7aca59";

fn ecb_encrypt(key: &[u8; 16], plaintext: &[u8]) -> String {
    use aes::Aes128;
    use cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyInit};
    let enc = ecb::Encryptor::<Aes128>::new_from_slice(key).unwrap();
    STANDARD.encode(enc.encrypt_padded_vec_mut::<Pkcs7>(plaintext))
}

fn ecb_decrypt(key: &[u8; 16], pack: &str) -> Vec<u8> {
    use aes::Aes128;
    use cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyInit};
    let dec = ecb::Decryptor::<Aes128>::new_from_slice(key).unwrap();
    dec.decrypt_padded_vec_mut::<Pkcs7>(&STANDARD.decode(pack).unwrap())
        .unwrap()
}

fn gcm_encrypt(key: &[u8; 16], plaintext: &[u8]) -> (String, String) {
    use aes_gcm::aead::{AeadInPlace, KeyInit};
    use aes_gcm::{Aes128Gcm, Nonce};
    let cipher = Aes128Gcm::new_from_slice(key).unwrap();
    let mut buffer = plaintext.to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&GCM_NONCE), GCM_AAD, &mut buffer)
        .unwrap();
    (STANDARD.encode(&buffer), STANDARD.encode(tag.as_slice()))
}

fn gcm_decrypt(key: &[u8; 16], pack: &str, tag: &str) -> Vec<u8> {
    use aes_gcm::aead::{AeadInPlace, KeyInit};
    use aes_gcm::{Aes128Gcm, Nonce, Tag};
    let cipher = Aes128Gcm::new_from_slice(key).unwrap();
    let mut buffer = STANDARD.decode(pack).unwrap();
    let tag_bytes = STANDARD.decode(tag).unwrap();
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&GCM_NONCE),
            GCM_AAD,
            &mut buffer,
            Tag::from_slice(&tag_bytes),
        )
        .unwrap();
    buffer
}

/// The device's property map, shared so a test can assert what a command
/// actually wrote.
type SharedProps = Arc<Mutex<BTreeMap<String, i64>>>;

fn initial_props() -> BTreeMap<String, i64> {
    BTreeMap::from([
        ("Pow".to_string(), 1),
        ("Mod".to_string(), 1),   // cool
        ("SetTem".to_string(), 24),
        ("TemSen".to_string(), 62), // 22 °C after the -40 offset
        ("OutEnvTem".to_string(), 71), // 31 °C
        ("WdSpd".to_string(), 0),
        ("Lig".to_string(), 1),
    ])
}

/// Spawn the stand-in device. Returns the port it listens on and its property
/// map. The thread exits when the test process does.
fn spawn_device(firmware: Firmware) -> (u16, SharedProps) {
    let socket = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    let port = socket.local_addr().unwrap().port();
    let props: SharedProps = Arc::new(Mutex::new(initial_props()));

    let device_props = props.clone();
    std::thread::spawn(move || {
        let mut active = Cipher::Ecb;
        let mut key = *ECB_GENERIC_KEY;
        let mut binds_seen = 0;
        let mut buf = [0u8; 4096];

        loop {
            let Ok((n, from)) = socket.recv_from(&mut buf) else {
                return;
            };
            if Firmware::NoisyLan == firmware {
                // Neither valid JSON nor decryptable under any key.
                socket.send_to(b"\x00\xff not a gree packet", from).unwrap();
            }

            let datagram: serde_json::Value = serde_json::from_slice(&buf[..n]).unwrap();

            // The scan is the only plaintext message in the protocol.
            if Some("scan") == datagram.get("t").and_then(serde_json::Value::as_str) {
                let dev = if Firmware::EmptyCid == firmware {
                    serde_json::json!({ "t": "dev", "cid": "", "mac": DEVICE_ID, "bc": "gree" })
                } else {
                    serde_json::json!({ "t": "dev", "cid": DEVICE_ID, "bc": "gree" })
                };
                reply(&socket, from, active, &key, &dev);
                continue;
            }

            let pack = datagram["pack"].as_str().unwrap();
            let plaintext = match active {
                Cipher::Ecb => ecb_decrypt(&key, pack),
                Cipher::Gcm => gcm_decrypt(&key, pack, datagram["tag"].as_str().unwrap()),
            };
            let request: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();

            match request["t"].as_str().unwrap() {
                "bind" => {
                    // A real unit only answers a bind addressed to its own id;
                    // a bind carrying an empty or foreign mac dies in silence.
                    if Some(DEVICE_ID) != request["mac"].as_str() {
                        continue;
                    }
                    binds_seen += 1;
                    if Firmware::IgnoreFirstBind == firmware && 1 == binds_seen {
                        // Stay silent. The client's retry is GCM-encrypted, so
                        // move to that cipher (still the generic key) to read it.
                        active = Cipher::Gcm;
                        key = *GCM_GENERIC_KEY;
                        continue;
                    }
                    let ok = serde_json::json!({
                        "t": "bindok",
                        "mac": request["mac"],
                        "key": String::from_utf8_lossy(DEVICE_KEY),
                    });
                    // Encrypted under the GENERIC key: the client only installs
                    // the device key after decrypting this.
                    reply(&socket, from, active, &key, &ok);
                    key = *DEVICE_KEY;
                }
                "status" => {
                    let state = device_props.lock().unwrap();
                    // Mirror a real unit: answer only the codes it knows,
                    // silently dropping the rest.
                    let (cols, values): (Vec<&str>, Vec<i64>) = request["cols"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|col| {
                            let col = col.as_str()?;
                            Some((col, *state.get(col)?))
                        })
                        .unzip();
                    let dat = serde_json::json!({ "t": "dat", "cols": cols, "dat": values });
                    reply(&socket, from, active, &key, &dat);
                }
                "cmd" => {
                    let opt = request["opt"].as_array().unwrap().clone();
                    let p = request["p"].as_array().unwrap().clone();
                    let mut state = device_props.lock().unwrap();
                    for (code, value) in opt.iter().zip(p.iter()) {
                        state.insert(
                            code.as_str().unwrap().to_string(),
                            value.as_i64().unwrap(),
                        );
                    }
                    let res = serde_json::json!({ "t": "res", "opt": opt, "val": p });
                    reply(&socket, from, active, &key, &res);
                }
                other => panic!("unexpected request type {other}"),
            }
        }
    });

    (port, props)
}

fn reply(
    socket: &UdpSocket,
    to: SocketAddr,
    active: Cipher,
    key: &[u8; 16],
    inner: &serde_json::Value,
) {
    let plaintext = serde_json::to_vec(inner).unwrap();
    let envelope = match active {
        Cipher::Ecb => serde_json::json!({
            "t": "pack", "i": 1, "uid": 0, "cid": "",
            "pack": ecb_encrypt(key, &plaintext),
        }),
        Cipher::Gcm => {
            let (pack, tag) = gcm_encrypt(key, &plaintext);
            serde_json::json!({
                "t": "pack", "i": 1, "uid": 0, "cid": "", "pack": pack, "tag": tag,
            })
        }
    };
    socket
        .send_to(&serde_json::to_vec(&envelope).unwrap(), to)
        .unwrap();
}

/// Pump the client until it yields an event, or fail after `timeout`.
fn next_event(client: &mut Client, timeout: Duration) -> Event {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(event) = client.poll_once().expect("poll failed") {
            return event;
        }
    }
    panic!("no event within {timeout:?}");
}

fn connect(port: u16) -> Client {
    Client::connect(ClientConfig {
        host: "127.0.0.1".to_string(),
        port,
        ..Default::default()
    })
    .expect("handshake failed")
}

#[test]
fn binds_and_exchanges_state_over_ecb() {
    let (port, device) = spawn_device(Firmware::Ecb);
    let mut client = connect(port);
    assert_eq!(Some("f4911e7aca59"), client.device_id());

    client.request_status().unwrap();
    let Event::Update(changed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a status update");
    };

    assert_eq!(Some(&1), changed.get(&Property::Power));
    assert_eq!(Some(&24), changed.get(&Property::Temperature));
    // Raw values; the -40 sensor offset is applied when they are rendered.
    assert_eq!(Some(&62), changed.get(&Property::CurrentTemperature));
    assert_eq!(Some(&71), changed.get(&Property::OutdoorTemperature));

    // A second status with nothing changed must not produce an event.
    client.request_status().unwrap();
    let quiet_until = Instant::now() + Duration::from_millis(400);
    while Instant::now() < quiet_until {
        assert!(client.poll_once().unwrap().is_none(), "unchanged poll fired");
    }

    // A write reaches the device and comes back confirmed.
    client
        .send_command(&[(Property::Power, 0), (Property::Temperature, 19)])
        .unwrap();
    let Event::Success(confirmed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a command confirmation");
    };

    assert_eq!(Some(&0), confirmed.get(&Property::Power));
    assert_eq!(Some(&19), confirmed.get(&Property::Temperature));
    assert_eq!(Some(&0), client.properties().get(&Property::Power));
    assert_eq!(Some(&0), device.lock().unwrap().get("Pow"));
    assert_eq!(Some(&19), device.lock().unwrap().get("SetTem"));
}

#[test]
fn an_unchanged_status_reply_still_refreshes_contact() {
    // Regression: the daemon's offline timer advanced only when a property
    // *changed*, but `poll_once` returns None both for a socket timeout and for
    // a status reply whose values are identical. An idle unit that dutifully
    // answered every poll was therefore declared offline every few seconds and
    // reconnected in a loop. An unchanged reply must still count as contact.
    let (port, _device) = spawn_device(Firmware::IgnoreFirstBind); // the v1.45 path
    let mut client = connect(port);

    // Populate the property map with a first (changing) status.
    client.request_status().unwrap();
    let _ = next_event(&mut client, Duration::from_secs(3));

    // Let contact age past a clear threshold.
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        client.since_contact() >= Duration::from_millis(200),
        "contact should have aged while idle"
    );

    // Ask again: the values are identical, so every poll_once yields None...
    client.request_status().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while client.since_contact() >= Duration::from_millis(200) && Instant::now() < deadline {
        assert!(
            client.poll_once().unwrap().is_none(),
            "identical values, so no change event"
        );
    }

    // ...yet that identical reply must have refreshed contact.
    assert!(
        client.since_contact() < Duration::from_millis(200),
        "an unchanged status reply must still count as contact"
    );
}

#[test]
fn falls_back_to_gcm_when_the_first_bind_is_ignored() {
    // The path the Umi's v1.45 firmware takes.
    let (port, device) = spawn_device(Firmware::IgnoreFirstBind);
    let mut client = connect(port);

    client.request_status().unwrap();
    let Event::Update(changed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a status update");
    };
    assert_eq!(Some(&1), changed.get(&Property::Mode));

    client.send_command(&[(Property::Lights, 0)]).unwrap();
    let Event::Success(confirmed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a command confirmation");
    };
    assert_eq!(Some(&0), confirmed.get(&Property::Lights));
    assert_eq!(Some(&0), device.lock().unwrap().get("Lig"));
}

#[test]
fn an_empty_cid_in_the_dev_pack_falls_back_to_the_mac() {
    // Most EWPE dev packs carry `"cid":""` with the real device id only in
    // `mac`. Binding must use the mac then (the JS library's `cid || mac`) —
    // an empty-mac bind is ignored by the unit and the connect never completes.
    let (port, _device) = spawn_device(Firmware::EmptyCid);
    let mut client = connect(port);
    assert_eq!(Some(DEVICE_ID), client.device_id());

    client.request_status().unwrap();
    let Event::Update(changed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a status update");
    };
    assert_eq!(Some(&24), changed.get(&Property::Temperature));
}

#[test]
fn stray_datagrams_do_not_kill_the_session() {
    // Junk on the socket used to propagate out of poll_once as an error, which
    // the daemon treats as a dead session — so one broadcast from a neighbour's
    // Gree unit cost a full re-handshake and an offline blip in the UI.
    let (port, device) = spawn_device(Firmware::NoisyLan);
    let mut client = connect(port);

    client.request_status().unwrap();
    let Event::Update(changed) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a status update despite the noise");
    };
    assert_eq!(Some(&24), changed.get(&Property::Temperature));

    client.send_command(&[(Property::Power, 0)]).unwrap();
    let Event::Success(_) = next_event(&mut client, Duration::from_secs(3)) else {
        panic!("expected a command confirmation despite the noise");
    };
    assert_eq!(Some(&0), device.lock().unwrap().get("Pow"));
}

#[test]
fn read_only_properties_are_refused_before_they_reach_the_wire() {
    let (port, device) = spawn_device(Firmware::Ecb);
    let mut client = connect(port);

    let err = client.send_command(&[(Property::CurrentTemperature, 20)]);
    assert!(err.is_err());
    assert_eq!(Some(&62), device.lock().unwrap().get("TemSen"));
}

#[test]
fn connect_gives_up_when_nothing_answers() {
    // Port 1 on loopback: nothing listens, so the scan is never answered.
    let started = Instant::now();
    let result = Client::connect(ClientConfig {
        host: "127.0.0.1".to_string(),
        port: 1,
        connect_timeout: Duration::from_millis(400),
        ..Default::default()
    });

    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(2), "hung past its timeout");
}

//! Blocking UDP client and connection state machine. No async runtime: one
//! socket, deadline-driven timeouts. Poll with `poll_once` in a loop; drive
//! writes with `request_status` / `send_command`.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use crate::crypto::EncryptionService;
use crate::error::{Error, Result};
use crate::property::Property;
use crate::protocol::{BindReq, CmdReq, Envelope, Inbound, Pack, StatusReq};

#[derive(Clone, Debug)]
pub struct ClientConfig {
    pub host: String,
    pub port: u16,
    /// Overall budget for scan + bind before giving up.
    pub connect_timeout: Duration,
    /// Wait after the ECB bind before retrying with GCM.
    pub bind_timeout: Duration,
    /// Per-recv blocking timeout, and the deadline-check granularity. Because
    /// the device thread blocks here between packets, this also bounds how long
    /// a queued command waits before it is sent — it is the bridge's only
    /// self-inflicted write latency (measured: everything else totals ~70 ms
    /// tap-to-ack). Lower = snappier control at the cost of more idle wakeups
    /// (50/s at 20 ms — negligible even on a Pi Zero W); higher = fewer wakeups.
    pub read_timeout: Duration,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            host: "192.168.1.255".to_string(),
            port: 7000,
            connect_timeout: Duration::from_secs(3),
            bind_timeout: Duration::from_millis(500),
            read_timeout: Duration::from_millis(20),
        }
    }
}

/// State change observed from the device.
#[derive(Debug)]
#[non_exhaustive]
pub enum Event {
    /// Properties changed on the unit (initial status, or an external change
    /// e.g. the IR remote). Carries only the delta.
    Update(HashMap<Property, i64>),
    /// A command we sent was acknowledged. Carries the confirmed properties.
    Success(HashMap<Property, i64>),
}

pub struct Client {
    socket: UdpSocket,
    target: SocketAddr,
    config: ClientConfig,
    enc: EncryptionService,
    cid: Option<String>,
    /// Source IP the session accepts datagrams from. Set up front when the
    /// target is unicast; for a broadcast target it is unknown until the scan
    /// is answered, and locks to the source of the accepted `dev` pack. During
    /// (re)connect the generic keys are public, so without this any LAN host
    /// answering the scan first could complete the bind with its own key.
    /// A software filter rather than `socket.connect()`, because `send_to` on
    /// a connected UDP socket errors on macOS.
    peer: Option<IpAddr>,
    properties: HashMap<Property, i64>,
    /// When we last decoded a datagram from the device. Refreshed on every
    /// reply, including a status poll that changed nothing — that is still
    /// proof the unit is answering. See [`Client::since_contact`].
    last_rx: Instant,
}

impl Client {
    /// Bind a local socket, run scan -> bind (ECB, then GCM) -> bindok, and
    /// return a connected client. Blocks until connected or `connect_timeout`.
    pub fn connect(config: ClientConfig) -> Result<Self> {
        let target = (config.host.as_str(), config.port)
            .to_socket_addrs()?
            .next()
            .ok_or(Error::NotConnected)?;

        let socket = UdpSocket::bind(("0.0.0.0", 0))?;
        socket.set_broadcast(true)?;
        socket.set_read_timeout(Some(config.read_timeout))?;

        let peer = if is_broadcast_address(target.ip()) {
            None
        } else {
            Some(target.ip())
        };

        let mut client = Self {
            socket,
            target,
            config,
            enc: EncryptionService::new(),
            cid: None,
            peer,
            properties: HashMap::new(),
            last_rx: Instant::now(),
        };
        client.handshake()?;
        client.last_rx = Instant::now(); // the bindok we just decoded is contact
        Ok(client)
    }

    pub fn device_id(&self) -> Option<&str> {
        self.cid.as_deref()
    }

    /// Time since the last decodable datagram from the device. A status reply
    /// that changed nothing still counts — it proves the unit is answering. The
    /// daemon keys its offline detection on this: a `send` never fails just
    /// because the unit vanished, so elapsed silence is the only signal that it
    /// has dropped off Wi-Fi.
    pub fn since_contact(&self) -> Duration {
        self.last_rx.elapsed()
    }

    pub fn properties(&self) -> &HashMap<Property, i64> {
        &self.properties
    }

    fn handshake(&mut self) -> Result<()> {
        let scan = serde_json::to_vec(&serde_json::json!({ "t": "scan" }))?;
        self.send_raw(&scan)?;

        let connect_deadline = Instant::now() + self.config.connect_timeout;
        let mut bind_deadline: Option<Instant> = None;
        let mut buf = [0u8; 2048];

        loop {
            if Instant::now() >= connect_deadline {
                return Err(Error::ConnectTimeout);
            }

            if let Some(deadline) = bind_deadline {
                if Instant::now() >= deadline {
                    self.send_bind()?; // attempt 2 -> flips cipher to GCM
                    bind_deadline = None; // single retry, matching JS
                }
            }

            match self.socket.recv_from(&mut buf) {
                // Unreadable datagrams are ignored rather than fatal: the scan
                // is a broadcast, so a second Gree device on the LAN may answer
                // too. Keep listening until the connect deadline.
                Ok((n, from)) => {
                    if !self.accepts(from.ip()) {
                        log::debug!("ignoring {n}-byte datagram from unexpected source {from}");
                        continue;
                    }
                    match self.decode(&buf[..n]) {
                        Ok(Pack::Handshake { cid, mac }) => {
                            // The device that answered the scan is the session
                            // peer from here on.
                            self.peer = Some(from.ip());
                            // Most EWPE dev packs carry `"cid":""` with the real id
                            // in `mac`; an empty cid must fall through (JS: cid || mac).
                            self.cid = cid.filter(|s| !s.is_empty()).or(mac);
                            self.send_bind()?; // attempt 1 -> ECB
                            bind_deadline = Some(Instant::now() + self.config.bind_timeout);
                        }
                        Ok(Pack::BindOk { .. }) => return Ok(()), // key installed in decrypt
                        Ok(_) => {}
                        Err(e) => log::debug!("ignoring undecodable {n}-byte datagram: {e}"),
                    }
                }
                Err(e) if is_timeout(&e) => continue,
                Err(e) => return Err(Error::Io(e)),
            }
        }
    }

    /// Request a full status snapshot. Non-blocking send; the `dat` reply
    /// arrives via `poll_once`.
    pub fn request_status(&mut self) -> Result<()> {
        let cols: [&'static str; Property::ALL.len()] = Property::ALL.map(|p| p.code());
        self.request_status_cols(&cols)
    }

    /// Request an arbitrary set of column codes, including ones `Property` does
    /// not model. Diagnostics only (see the `probe` binary) — replies to codes
    /// outside `Property` are invisible to `poll_once`; read them with
    /// [`Client::poll_json`].
    ///
    /// Note: a unit truncates its reply back to its core columns when asked for
    /// too many at once, so probe small focused sets.
    pub fn request_status_cols(&mut self, cols: &[&str]) -> Result<()> {
        let mac = self.cid.clone().ok_or(Error::NotConnected)?;
        let inner = serde_json::to_vec(&StatusReq {
            cols,
            mac: &mac,
            t: "status",
        })?;
        let (pack, tag) = self.enc.encrypt(&inner, false)?;
        self.send_envelope(0, &pack, tag.as_deref())
    }

    /// Send a batch of property writes. Confirmation arrives via `poll_once`.
    /// Read-only properties (e.g. `currentTemperature`) are rejected here so the
    /// invariant is enforced by the library, not only at the HTTP edge.
    pub fn send_command(&mut self, props: &[(Property, i64)]) -> Result<()> {
        if let Some((p, _)) = props.iter().find(|(p, _)| p.read_only()) {
            return Err(Error::ReadOnly(p.name()));
        }
        let opt: Vec<&'static str> = props.iter().map(|(p, _)| p.code()).collect();
        let values: Vec<i64> = props.iter().map(|(_, v)| *v).collect();
        let inner = serde_json::to_vec(&CmdReq {
            opt: &opt,
            p: &values,
            t: "cmd",
        })?;
        let (pack, tag) = self.enc.encrypt(&inner, false)?;
        self.send_envelope(0, &pack, tag.as_deref())
    }

    /// One blocking recv bounded by `read_timeout`. Returns `None` on timeout
    /// (no traffic), otherwise the decoded state change.
    pub fn poll_once(&mut self) -> Result<Option<Event>> {
        let mut buf = [0u8; 2048];
        match self.socket.recv_from(&mut buf) {
            // A datagram we can't read is not a broken session. Another Gree
            // device's broadcast, a reply encrypted under the key we had before
            // the last bind, or any stray UDP on our ephemeral port would
            // otherwise cost a full scan/bind re-handshake and a visible
            // offline blip. Drop it and keep the session.
            Ok((n, from)) => {
                if !self.accepts(from.ip()) {
                    log::debug!("ignoring {n}-byte datagram from unexpected source {from}");
                    return Ok(None);
                }
                match self.decode(&buf[..n]) {
                    Ok(pack) => {
                        // A decoded datagram is our device answering (a foreign
                        // unit's reply would not decrypt under our key), so it is
                        // contact even when it carries no state change.
                        self.last_rx = Instant::now();
                        Ok(self.apply(pack))
                    }
                    Err(e) => {
                        log::debug!("ignoring undecodable {n}-byte datagram: {e}");
                        Ok(None)
                    }
                }
            }
            Err(e) if is_timeout(&e) => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    /// One blocking recv that yields the DECRYPTED pack as raw JSON, bypassing
    /// the typed model. Diagnostics only — the daemon uses `poll_once`. Pairs
    /// with [`Client::request_status_cols`] to observe undocumented codes.
    pub fn poll_json(&mut self) -> Result<Option<serde_json::Value>> {
        let mut buf = [0u8; 2048];
        match self.socket.recv_from(&mut buf) {
            Ok((n, from)) => {
                if !self.accepts(from.ip()) {
                    log::debug!("ignoring {n}-byte datagram from unexpected source {from}");
                    return Ok(None);
                }
                self.decrypt_datagram(&buf[..n]).map(Some)
            }
            Err(e) if is_timeout(&e) => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    fn apply(&mut self, pack: Pack) -> Option<Event> {
        match pack {
            Pack::Status { cols, dat } => {
                let mut changed = HashMap::new();
                for (code, value) in cols.iter().zip(dat.iter()) {
                    let (Some(p), Some(v)) = (Property::from_code(code), value.as_i64())
                    else {
                        continue;
                    };
                    if self.properties.insert(p, v) != Some(v) {
                        changed.insert(p, v);
                    }
                }
                if changed.is_empty() {
                    return None;
                }
                Some(Event::Update(changed))
            }
            Pack::Result { opt, val, p } => {
                let values = val.or(p).unwrap_or_default();
                let mut confirmed = HashMap::new();
                for (code, value) in opt.iter().zip(values.iter()) {
                    let (Some(prop), Some(v)) =
                        (Property::from_code(code), value.as_i64())
                    else {
                        continue;
                    };
                    self.properties.insert(prop, v);
                    confirmed.insert(prop, v);
                }
                Some(Event::Success(confirmed))
            }
            _ => None,
        }
    }

    fn send_bind(&mut self) -> Result<()> {
        let mac = self.cid.clone().ok_or(Error::NotConnected)?;
        let inner = serde_json::to_vec(&BindReq {
            mac: &mac,
            t: "bind",
            uid: 0,
        })?;
        let (pack, tag) = self.enc.encrypt(&inner, true)?;
        self.send_envelope(1, &pack, tag.as_deref())
    }

    fn decrypt_datagram(&mut self, datagram: &[u8]) -> Result<serde_json::Value> {
        let inbound: Inbound = serde_json::from_slice(datagram)?;
        self.enc.decrypt(&inbound.pack, inbound.tag.as_deref())
    }

    fn decode(&mut self, datagram: &[u8]) -> Result<Pack> {
        let payload = self.decrypt_datagram(datagram)?;
        Ok(serde_json::from_value(payload)?)
    }

    fn send_envelope(&self, i: u8, pack: &str, tag: Option<&str>) -> Result<()> {
        let envelope = Envelope {
            cid: "app",
            i,
            t: "pack",
            uid: 0,
            pack,
            tag,
        };
        let bytes = serde_json::to_vec(&envelope)?;
        self.send_raw(&bytes)
    }

    fn send_raw(&self, bytes: &[u8]) -> Result<()> {
        self.socket.send_to(bytes, self.target)?;
        Ok(())
    }

    /// Whether a datagram from this source belongs to the session. Ports are
    /// not compared — some firmware replies from an ephemeral port, the IP is
    /// what identifies the device.
    fn accepts(&self, source: IpAddr) -> bool {
        if let Some(peer) = self.peer {
            peer == source
        } else {
            true
        }
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// Whether the configured target looks like a scan broadcast (the limited
/// broadcast, or an `x.x.x.255` directed broadcast — the subnet mask is
/// unknowable here, and every home /24 ends in .255). Anything else is treated
/// as the device's own unicast address.
fn is_broadcast_address(ip: IpAddr) -> bool {
    if let IpAddr::V4(v4) = ip {
        v4.is_broadcast() || 255 == v4.octets()[3]
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_targets_are_recognised() {
        assert!(is_broadcast_address("255.255.255.255".parse().unwrap()));
        assert!(is_broadcast_address("192.168.1.255".parse().unwrap()));
        assert!(!is_broadcast_address("192.168.1.50".parse().unwrap()));
        assert!(!is_broadcast_address("127.0.0.1".parse().unwrap()));
    }
}

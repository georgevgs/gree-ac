//! Device thread. Owns the blocking `Client`, self-polls on an interval,
//! applies inbound commands, and publishes state to the web layer via a shared
//! snapshot plus a broadcast channel. Detects a silently-unreachable device and
//! reconnects with backoff.
//!
//! The snapshot holds the raw property map rather than rendered JSON, so the
//! HTTP layer can shape it per endpoint (and overlay a just-written value on a
//! write response) without this thread knowing about the API.

use std::sync::mpsc::Receiver;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use greehvac::property::Property;
use greehvac::{Client, ClientConfig};
use tokio::sync::{broadcast, oneshot};

use crate::state::{self, Props};

/// A batch of property writes, plus a channel to report whether the datagram
/// actually went out. Writes are unacknowledged at the protocol level (UDP), so
/// `Ok` means "sent", not "the unit obeyed" — confirmation arrives as a `res`
/// reply on the next poll and lands in the snapshot.
pub enum Command {
    Set(Vec<(Property, i64)>, oneshot::Sender<Result<(), String>>),
}

#[derive(Clone, Default)]
pub struct DeviceState {
    pub online: bool,
    pub props: Props,
    /// When the device last reported a *change*. `None` until the first one.
    pub updated_at: Option<SystemTime>,
}

pub type Snapshot = Arc<RwLock<DeviceState>>;

pub fn run(
    host: String,
    port: u16,
    poll_interval: Duration,
    cmd_rx: Receiver<Command>,
    snapshot: Snapshot,
    updates: broadcast::Sender<String>,
) {
    let base = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);
    let mut backoff = base;
    let mut was_connected = false;

    loop {
        let config = ClientConfig {
            host: host.clone(),
            port,
            ..Default::default()
        };

        let started = Instant::now();
        match Client::connect(config) {
            Ok(client) => {
                log::info!("connected to device {:?}", client.device_id());
                was_connected = true;
                serve(client, &cmd_rx, poll_interval, &snapshot, &updates);
                log::warn!("device loop ended");
            }
            Err(e) => log::warn!("connect failed: {e}"),
        }

        // We are no longer talking to the device. Tell the UI once per outage so
        // it can show an offline state instead of silently freezing.
        if was_connected {
            announce_offline(&snapshot, &updates);
            was_connected = false;
        }

        // A session that lasted a while was healthy — reset the backoff. One
        // that died almost immediately gets progressively longer delays so we
        // never hammer the device with scan+bind on a tight loop.
        if started.elapsed() >= Duration::from_secs(5) {
            backoff = base;
        }
        log::info!("reconnecting in {backoff:?}");
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(max_backoff);
    }
}

fn serve(
    mut client: Client,
    cmd_rx: &Receiver<Command>,
    poll_interval: Duration,
    snapshot: &Snapshot,
    updates: &broadcast::Sender<String>,
) {
    // Anything queued during the outage is stale — a setpoint the user chose
    // minutes ago shouldn't fire the moment the unit comes back. Dropping the
    // reply channel tells any still-waiting request that its write was lost.
    while cmd_rx.try_recv().is_ok() {}

    if let Err(e) = client.request_status() {
        log::warn!("initial status request failed: {e}");
        return;
    }

    // Sustained silence (device off, or dropped from Wi-Fi) never surfaces as a
    // socket error: sends "succeed" and recvs just time out. Treat several
    // missed polls in a row as unreachable, and return so run() reconnects.
    // Contact is tracked by the client itself (`since_contact`) and counts every
    // decoded reply — including a status poll that changed nothing — so a steady
    // idle unit is not mistaken for a dead one.
    let offline_after = (poll_interval * 3).max(Duration::from_secs(6));
    let mut last_poll = Instant::now();

    loop {
        while let Ok(Command::Set(props, reply)) = cmd_rx.try_recv() {
            match client.send_command(&props) {
                Ok(()) => {
                    let _ = reply.send(Ok(()));
                    // Ask for a fresh snapshot right away: the unit answers a
                    // command with the values it actually accepted, so the UI's
                    // optimistic echo is corrected within one round trip.
                    if let Err(e) = client.request_status() {
                        log::warn!("post-command status request failed: {e}");
                        return;
                    }
                    last_poll = Instant::now();
                }
                Err(e) => {
                    log::warn!("command send failed: {e}");
                    let _ = reply.send(Err(e.to_string()));
                    return;
                }
            }
        }

        if last_poll.elapsed() >= poll_interval {
            if let Err(e) = client.request_status() {
                log::warn!("status request failed: {e}");
                return;
            }
            last_poll = Instant::now();
        }

        match client.poll_once() {
            // Some => a value changed; push it. None => a timeout or an
            // unchanged reply, neither of which the UI needs to hear about.
            Ok(Some(_event)) => publish(client.properties(), snapshot, updates),
            Ok(None) => {}
            Err(e) => {
                log::warn!("poll error: {e}");
                return;
            }
        }

        if client.since_contact() >= offline_after {
            log::warn!(
                "no response for {:?}; treating device as offline",
                client.since_contact()
            );
            return;
        }
    }
}

/// Publish a live change: refresh the shared snapshot and push the new state to
/// every SSE subscriber.
fn publish(props: &Props, snapshot: &Snapshot, updates: &broadcast::Sender<String>) {
    let next = DeviceState {
        online: true,
        props: props.clone(),
        updated_at: Some(SystemTime::now()),
    };
    push(snapshot, next, updates);
}

/// Flip shared state to offline, preserving the last known settings, so the UI
/// can grey the controls out rather than blank the screen.
fn announce_offline(snapshot: &Snapshot, updates: &broadcast::Sender<String>) {
    let mut next = snapshot.read().map(|g| g.clone()).unwrap_or_default();
    next.online = false;
    push(snapshot, next, updates);
}

fn push(snapshot: &Snapshot, next: DeviceState, updates: &broadcast::Sender<String>) {
    let dto = state::dto(&next.props, next.online, next.updated_at);

    if let Ok(mut guard) = snapshot.write() {
        *guard = next;
    }

    match serde_json::to_string(&dto) {
        // Err only means nobody is subscribed.
        Ok(payload) => {
            let _ = updates.send(payload);
        }
        Err(e) => log::warn!("failed to serialize state: {e}"),
    }
}

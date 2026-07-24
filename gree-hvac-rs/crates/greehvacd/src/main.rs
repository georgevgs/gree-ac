//! Daemon entrypoint: spawn the blocking device thread, serve the HTTP/SSE API,
//! and optionally serve the built PWA so the whole app is one process and one
//! URL on the LAN.
//!
//! Configuration comes from CLI flags or the matching environment variables,
//! which are also read from a `.env` file in the working directory or any
//! parent — so the repo-root `.env` configures the daemon wherever it is
//! launched from.

mod actor;
mod api;
mod state;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use clap::Parser;
use tokio::sync::broadcast;

use actor::{Command, DeviceState, Snapshot};

#[derive(Parser)]
#[command(name = "greehvacd", about = "Gree HVAC control daemon")]
struct Args {
    /// LAN IP of the AC. Set a DHCP reservation so it never drifts; unicast is
    /// more reliable than the `.255` broadcast default.
    #[arg(long, env = "AC_HOST", default_value = "192.168.1.255")]
    host: String,
    /// GREE local UDP port. Rarely changed.
    #[arg(long, env = "AC_PORT", default_value_t = 7000)]
    ac_port: u16,
    /// HTTP listen address. 0.0.0.0 so any device on the Wi-Fi can reach it.
    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0")]
    bind: String,
    /// HTTP port for the API and the PWA.
    #[arg(long, env = "PORT", default_value_t = 8481)]
    port: u16,
    /// Polling cadence against the AC, in ms.
    #[arg(long, env = "POLL_INTERVAL_MS", default_value_t = 3000)]
    poll_interval_ms: u64,
    /// Comma-separated CORS allowlist, or `*` for any origin (the trusted-LAN
    /// default). Only matters when the PWA is served from somewhere else.
    #[arg(long, env = "CORS_ORIGIN")]
    cors_origin: Option<String>,
    /// Directory of built PWA files to serve (pwa/dist). Omit to run API-only.
    #[arg(long, env = "PUBLIC_DIR")]
    public_dir: Option<PathBuf>,
    /// If set, every /api request must send `Authorization: Bearer <token>`.
    /// Strongly recommended before exposing the daemon beyond a trusted LAN.
    #[arg(long, env = "API_TOKEN")]
    token: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub snapshot: Snapshot,
    pub cmd_tx: mpsc::Sender<Command>,
    pub updates: broadcast::Sender<String>,
}

// current_thread: a Pi Zero W has one core and device I/O runs on its own std
// thread, so a multi-thread scheduler would only add overhead.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _ = dotenvy::dotenv(); // absent .env is fine — flags/env still apply.

    // GREE_LOG_LEVEL is what this project's .env has always used; RUST_LOG wins
    // when both are set.
    let default_level = std::env::var("GREE_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_level))
        .init();

    drop_blank_env();
    let args = Args::parse();

    let snapshot: Snapshot = Arc::new(RwLock::new(DeviceState::default()));
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let (updates, _rx) = broadcast::channel::<String>(64);

    {
        let snapshot = snapshot.clone();
        let updates = updates.clone();
        let host = args.host.clone();
        let poll = Duration::from_millis(args.poll_interval_ms);
        std::thread::Builder::new()
            .name("gree-device".to_string())
            .spawn(move || actor::run(host, args.ac_port, poll, cmd_rx, snapshot, updates))
            .expect("spawn device thread");
    }

    let state = AppState {
        snapshot,
        cmd_tx,
        updates,
    };

    let public_dir = args.public_dir.filter(|dir| {
        let exists = dir.is_dir();
        if !exists {
            log::warn!("PUBLIC_DIR set but not found: {}", dir.display());
        }
        exists
    });
    if let Some(dir) = &public_dir {
        log::info!("serving PWA static files from {}", dir.display());
    }

    match &args.token {
        Some(_) => log::info!("bearer-token auth is enabled on /api"),
        None => log::warn!(
            "SECURITY: /api has no auth — LAN/Tailscale-only trust assumption. \
             Do not expose publicly."
        ),
    }

    let app = api::router(
        state,
        api::ApiConfig {
            cors_origin: args.cors_origin,
            token: args.token,
            public_dir,
        },
    );

    let addr = format!("{}:{}", args.bind, args.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot listen on {addr}: {e}"));
    log::info!("listening on http://{addr}");
    log::info!("target AC: {}:{}", args.host, args.ac_port);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve");
}

/// Treat a blank environment variable as unset. `.env` files habitually keep a
/// key with an empty value instead of deleting the line (`PUBLIC_DIR=`), and
/// clap would otherwise reject that as "a value is required".
fn drop_blank_env() {
    const KEYS: [&str; 8] = [
        "AC_HOST",
        "AC_PORT",
        "BIND_ADDR",
        "PORT",
        "POLL_INTERVAL_MS",
        "CORS_ORIGIN",
        "PUBLIC_DIR",
        "API_TOKEN",
    ];

    for key in KEYS {
        if std::env::var(key).is_ok_and(|value| value.trim().is_empty()) {
            std::env::remove_var(key);
        }
    }
}

/// Stop on Ctrl-C or `systemctl stop`, so a restart doesn't have to wait out
/// the socket.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(e) => log::warn!("cannot listen for SIGTERM: {e}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    log::info!("shutting down");
}

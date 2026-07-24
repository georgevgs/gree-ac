//! Read-only LAN diagnostic to discover raw GREE column codes a unit carries
//! beyond the ones `greehvac` models — self-clean, i-Feel, sterilization,
//! energy counters, and anything else firmware might expose under a name nobody
//! has mapped.
//!
//! It sends only `status` requests, never `cmd`, so it cannot change the AC. It
//! reuses the same scan/bind/AES-GCM handshake as the daemon, so it needs no
//! keys and no internet — the same LAN UDP path (port 7000).
//!
//!   cargo run -p greehvac-probe                     # AC_HOST from .env
//!   cargo run -p greehvac-probe -- --host 192.168.1.50
//!
//! Then press a button on the AC's remote (or toggle it in the Ewpe Smart app)
//! and watch for a CHANGED line — the code that flips is that feature.
//!
//!   --codes FooBar,BazQux   append extra candidates
//!   --only Pow,Mod,SetTem   REPLACE the column list entirely
//!
//! `--only` matters because a unit truncates its reply when asked for too many
//! columns at once (a ~90-column request came back with only the 17 core codes,
//! dropping even OutEnvTem, which it does support). Probe small focused sets to
//! tell "unsupported" apart from "truncated".

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use clap::Parser;
use greehvac::{Client, ClientConfig};

/// Codes the protocol already models, plus ones this unit was observed to
/// report. Included so you can confirm the probe works (change the temperature
/// on the remote and `SetTem` moves) and so real features aren't mistaken for
/// discoveries.
const KNOWN_CODES: &[&str] = &[
    "Pow", "Mod", "SetTem", "WdSpd", "Air", "Blo", "Health", "SwhSlp", "Lig", "SwingLfRig",
    "SwUpDn", "Quiet", "Tur", "StHt", "TemUn", "HeatCoolType", "TemRec", "SvSt", "TemSen",
    "SlpMod", "AntiDirectBlow", "LigSen", "OutEnvTem", "DwatSen",
];

/// Candidates for undocumented features. GREE firmware naming is inconsistent
/// across models, so cast a wide net — a device silently ignores codes it
/// doesn't recognise, which makes extras safe.
const CANDIDATE_CODES: &[&str] = &[
    // Self-clean / auto-clean / sterilization
    "SelfClean", "SlfClean", "Clean", "CleanMod", "CleanFlag", "CleanStatus", "AutoClean",
    "SmartClean", "CtlClean", "WipeMod", "Wipe", "MvStpFlg", "SterMod", "Ster", "Steril",
    "Sterilize", "StrlMod", "DryClean", "DryMod", "SC", "Cl", "HcSt",
    // UV-C / plasma / anion sterilizers (some units badge "self-clean" as these)
    "UvcControl", "Uvc", "UVC", "Plasma", "ColdPlasma", "Anion",
    // i-Feel / i-Sense (remote-temperature feed)
    "iFeel", "IFeel", "iFeelSet", "IFeelMode", "SetIFeel", "TeF", "TeFn", "iFeelTem", "FeelTem",
    // Energy and compressor load. The GREE local protocol has no standard
    // energy channel, so this hunts for either a true meter (Watt / current, or
    // a monotonic kWh accumulator) or compressor frequency — inverter power
    // scales roughly linearly with it.
    "CmpFrq", "CompFreq", "CompressorFrequency", "RealFrq", "FreqReal", "HzReal", "HzTarget",
    "OutFrq", "Freq", "RfrqSt", "CompFrqReal", "Watt", "WdWatt", "ElcWatt", "Power", "Pwr",
    "ActPow", "EnLen", "ElcInLen", "ElcOutLen", "ElecEn", "EnergyLen", "Elec", "AeCurr", "RfCur",
    "Curr", "ICur", "Volt", "Vol",
];

#[derive(Parser)]
#[command(name = "greehvac-probe", about = "Read-only GREE property-code probe")]
struct Args {
    /// LAN IP of the AC.
    #[arg(long, env = "AC_HOST", default_value = "192.168.1.255")]
    host: String,
    #[arg(long, env = "AC_PORT", default_value_t = 7000)]
    ac_port: u16,
    /// How often to request a status snapshot, in ms.
    #[arg(long, default_value_t = 2000)]
    poll_ms: u64,
    /// Extra candidate codes to append, comma-separated.
    #[arg(long, value_delimiter = ',')]
    codes: Vec<String>,
    /// Replace the whole column list with just these, comma-separated.
    #[arg(long, value_delimiter = ',')]
    only: Vec<String>,
}

type Row = BTreeMap<String, serde_json::Value>;

fn main() {
    let _ = dotenvy::dotenv();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args = Args::parse();

    let cols = columns(&args);
    println!("[probe] connecting to {}:{} …", args.host, args.ac_port);

    let config = ClientConfig {
        host: args.host.clone(),
        port: args.ac_port,
        ..Default::default()
    };
    let mut client = match Client::connect(config) {
        Ok(client) => client,
        Err(e) => {
            eprintln!("[probe] connect failed: {e}");
            eprintln!("[probe] check that AC_HOST is right and this machine is on the AC's Wi-Fi.");
            std::process::exit(1);
        }
    };

    println!(
        "[probe] connected to AC at {} (device {})",
        args.host,
        client.device_id().unwrap_or("unknown")
    );
    println!(
        "[probe] polling {} column codes every {}ms — read-only, Ctrl-C to stop",
        cols.len(),
        args.poll_ms
    );

    let refs: Vec<&str> = cols.iter().map(String::as_str).collect();
    let poll_interval = Duration::from_millis(args.poll_ms);
    let mut previous: Option<Row> = None;
    let mut polls = 0_u64;
    let mut last_request = Instant::now() - poll_interval;

    loop {
        if last_request.elapsed() >= poll_interval {
            if let Err(e) = client.request_status_cols(&refs) {
                eprintln!("[probe] status send: {e}");
            }
            last_request = Instant::now();
        }

        // Read the DECRYPTED pack as raw JSON: the typed model would drop
        // exactly the unknown codes we are hunting for.
        let packet = match client.poll_json() {
            Ok(Some(packet)) => packet,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("[probe] poll error: {e}");
                continue;
            }
        };
        let Some(row) = status_row(&packet) else {
            continue;
        };

        polls += 1;
        match &previous {
            None => report_baseline(&row, &cols),
            Some(prev) => report_changes(prev, &row, polls),
        }
        previous = Some(row);
    }
}

/// Known codes first, then candidates, then user extras — de-duplicated,
/// order preserved. `--only` replaces the lot.
fn columns(args: &Args) -> Vec<String> {
    let selected: Vec<&str> = if args.only.is_empty() {
        KNOWN_CODES
            .iter()
            .chain(CANDIDATE_CODES.iter())
            .copied()
            .chain(args.codes.iter().map(String::as_str))
            .collect()
    } else {
        args.only.iter().map(String::as_str).collect()
    };

    let mut seen = Vec::new();
    for code in selected {
        let code = code.trim();
        if !code.is_empty() && !seen.iter().any(|c: &String| c == code) {
            seen.push(code.to_string());
        }
    }
    seen
}

/// Pull `cols`/`dat` out of a `dat` packet, ignoring anything else on the wire.
fn status_row(packet: &serde_json::Value) -> Option<Row> {
    if Some("dat") != packet.get("t").and_then(serde_json::Value::as_str) {
        return None;
    }
    let cols = packet.get("cols")?.as_array()?;
    let values = packet.get("dat")?.as_array()?;

    Some(
        cols.iter()
            .zip(values.iter())
            .filter_map(|(col, value)| Some((col.as_str()?.to_string(), value.clone())))
            .collect(),
    )
}

fn report_baseline(row: &Row, requested: &[String]) {
    println!(
        "\n=== baseline (device returned {}/{} requested codes) ===",
        row.len(),
        requested.len()
    );
    for (code, value) in row {
        println!("  {code:<16} = {value}");
    }

    let ignored: Vec<&str> = requested
        .iter()
        .filter(|code| !row.contains_key(*code))
        .map(String::as_str)
        .collect();
    if !ignored.is_empty() {
        println!(
            "\n  not recognised by this unit (ignored): {}",
            ignored.join(", ")
        );
    }
    println!("\nNow press a button on the AC and watch for CHANGED lines…\n");
}

fn report_changes(previous: &Row, current: &Row, poll: u64) {
    let mut changes = Vec::new();
    for (code, value) in current {
        match previous.get(code) {
            Some(before) if before != value => {
                changes.push(format!("  CHANGED  {code:<16} {before} -> {value}"))
            }
            None => changes.push(format!("  NEW      {code:<16} = {value}")),
            _ => {}
        }
    }

    if changes.is_empty() {
        // Quiet heartbeat, so you know it's alive without flooding the console.
        print!("· poll #{poll} no change\r");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        return;
    }

    println!("--- change detected (poll #{poll}) ---");
    for line in changes {
        println!("{line}");
    }
    println!();
}

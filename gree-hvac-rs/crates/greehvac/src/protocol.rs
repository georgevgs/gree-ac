//! Wire types. Outbound inner messages are serialized, encrypted, then wrapped
//! in an `Envelope`. Inbound datagrams are an `Inbound` whose decrypted pack is
//! a `Pack` discriminated on `t`.

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct BindReq<'a> {
    pub mac: &'a str,
    pub t: &'a str,
    pub uid: u8,
}

#[derive(Serialize)]
pub struct StatusReq<'a> {
    pub cols: &'a [&'a str],
    pub mac: &'a str,
    pub t: &'a str,
}

#[derive(Serialize)]
pub struct CmdReq<'a> {
    pub opt: &'a [&'static str],
    pub p: &'a [i64],
    pub t: &'a str,
}

/// Outer UDP envelope carrying an encrypted pack.
#[derive(Serialize)]
pub struct Envelope<'a> {
    pub cid: &'a str,
    pub i: u8,
    pub t: &'a str,
    pub uid: u8,
    pub pack: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<&'a str>,
}

/// Outer inbound datagram: a base64 pack plus optional GCM tag.
#[derive(Deserialize)]
pub struct Inbound {
    pub pack: String,
    #[serde(default)]
    pub tag: Option<String>,
}

/// Decrypted pack, discriminated on `t`. Unknown fields on each device packet
/// (`bc`, `brand`, `r`, ...) are ignored.
#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum Pack {
    #[serde(rename = "dev")]
    Handshake {
        #[serde(default)]
        cid: Option<String>,
        #[serde(default)]
        mac: Option<String>,
    },
    #[serde(rename = "bindok")]
    BindOk {
        /// The device key. Installed by the crypto layer, which sees the raw
        /// JSON first; kept here so the packet shape documents itself.
        #[serde(default)]
        #[allow(dead_code)]
        key: Option<String>,
    },
    #[serde(rename = "dat")]
    Status {
        cols: Vec<String>,
        dat: Vec<serde_json::Value>,
    },
    #[serde(rename = "res")]
    Result {
        opt: Vec<String>,
        #[serde(default)]
        val: Option<Vec<serde_json::Value>>,
        #[serde(default)]
        p: Option<Vec<serde_json::Value>>,
    },
}

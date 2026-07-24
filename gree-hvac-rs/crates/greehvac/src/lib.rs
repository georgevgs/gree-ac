//! Gree-protocol HVAC client (EWPE Smart devices and rebrands such as Toyotomi
//! Umi). Runtime-agnostic: blocking UDP, no async dependency.

#![forbid(unsafe_code)]

pub mod client;
pub mod error;
pub mod property;

mod crypto;
mod protocol;

pub use client::{Client, ClientConfig, Event};
pub use error::{Error, Result};
pub use property::Property;

//! The friendly state DTO the PWA consumes, and the encoders for the
//! task-shaped write endpoints (`/api/power`, `/api/mode`, …).
//!
//! The device speaks vendor codes (`Pow`, `SetTem`, `Blo`); `greehvac` already
//! lifts those to an enum plus value tables. This module is the last hop: it
//! shapes them into one flat JSON object with app-level names, so the UI never
//! sees protocol internals. Absent properties (a unit that doesn't report one,
//! or a snapshot taken before the first poll) become `null`, except booleans,
//! which report `false` — the same convention the previous Node bridge used, so
//! the PWA's `ACState` type is unchanged.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use greehvac::property::{self, Property};
use serde::Serialize;

pub use greehvac::property::{TEMP_MAX, TEMP_MIN};

/// Mirrors `pwa/src/api/types.ts` field for field.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcState {
    /// Daemon-to-AC connection status.
    pub online: bool,
    pub power: bool,
    pub mode: Option<&'static str>,
    pub target_temp: Option<i64>,
    pub current_temp: Option<i64>,
    /// Outdoor sensor temperature (°C), read-only. `null` if the unit reports
    /// no sensor.
    pub outdoor_temp: Option<i64>,
    pub fan_speed: Option<&'static str>,
    pub swing_vert: Option<&'static str>,
    pub swing_hor: Option<&'static str>,
    pub air: Option<&'static str>,
    pub lights: bool,
    pub turbo: bool,
    pub quiet: Option<&'static str>,
    pub health: bool,
    pub xfan: bool,
    pub sleep: bool,
    pub power_save: bool,
    pub safety_heating: bool,
    pub unit: Option<&'static str>,
    pub updated_at: Option<String>,
}

pub type Props = HashMap<Property, i64>;

/// `1` is on for every boolean property in the protocol. A property the unit
/// never reported is off rather than unknown — the UI has no third state.
fn flag(props: &Props, p: Property) -> bool {
    Some(&1) == props.get(&p)
}

/// The enum name for a property's current value, e.g. `"cool"`. `None` when the
/// property is absent or carries a value outside the known table.
fn name(props: &Props, p: Property) -> Option<&'static str> {
    let raw = *props.get(&p)?;
    property::value_name(p, raw)
}

/// A raw numeric property (setpoint, sensor readings), with the sensor offset
/// already applied by `value_from_vendor`.
fn number(props: &Props, p: Property) -> Option<i64> {
    let raw = *props.get(&p)?;
    property::value_from_vendor(p, raw).as_i64()
}

pub fn dto(props: &Props, online: bool, updated_at: Option<SystemTime>) -> AcState {
    AcState {
        online,
        power: flag(props, Property::Power),
        mode: name(props, Property::Mode),
        target_temp: number(props, Property::Temperature),
        current_temp: number(props, Property::CurrentTemperature),
        outdoor_temp: number(props, Property::OutdoorTemperature),
        fan_speed: name(props, Property::FanSpeed),
        swing_vert: name(props, Property::SwingVert),
        swing_hor: name(props, Property::SwingHor),
        air: name(props, Property::Air),
        lights: flag(props, Property::Lights),
        turbo: flag(props, Property::Turbo),
        quiet: name(props, Property::Quiet),
        health: flag(props, Property::Health),
        xfan: flag(props, Property::Blow),
        sleep: flag(props, Property::Sleep),
        power_save: flag(props, Property::PowerSave),
        safety_heating: flag(props, Property::SafetyHeating),
        unit: name(props, Property::TemperatureUnit),
        updated_at: updated_at.map(iso8601),
    }
}

/// Format an instant as `2026-07-22T18:04:05.123Z`, matching
/// `Date.prototype.toISOString()`. Hand-rolled to keep the dependency tree (and
/// therefore the Pi build) small — this is the only date the daemon formats.
fn iso8601(at: SystemTime) -> String {
    let since_epoch = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();

    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3600,
        (secs_of_day / 60) % 60,
        secs_of_day % 60,
    )
}

/// Days since the Unix epoch -> civil (year, month, day). Howard Hinnant's
/// `civil_from_days`, which shifts the era to start in March so the leap day
/// lands at the end of a 400-year cycle and needs no special-casing.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(unix_millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(unix_millis)
    }

    #[test]
    fn iso8601_matches_javascript() {
        // Cross-checked against `new Date(ms).toISOString()`.
        assert_eq!(iso8601(at(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(at(1_769_000_000_123)), "2026-01-21T12:53:20.123Z");
        // Leap day, and the end of a century that is not a leap year.
        assert_eq!(iso8601(at(1_709_164_800_000)), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso8601(at(4_107_542_400_000)), "2100-03-01T00:00:00.000Z");
    }

    #[test]
    fn empty_state_is_all_null_and_false() {
        let state = dto(&Props::new(), false, None);
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["mode"], serde_json::Value::Null);
        assert_eq!(json["targetTemp"], serde_json::Value::Null);
        assert_eq!(json["power"], serde_json::json!(false));
        assert_eq!(json["updatedAt"], serde_json::Value::Null);
    }

    #[test]
    fn dto_uses_the_app_field_names() {
        let props = Props::from([
            (Property::Power, 1),
            (Property::Mode, 1),
            (Property::Temperature, 24),
            (Property::CurrentTemperature, 62),
            (Property::OutdoorTemperature, 71),
            (Property::FanSpeed, 5),
            (Property::Blow, 1),
            (Property::SafetyHeating, 0),
        ]);
        let json = serde_json::to_value(dto(&props, true, Some(at(0)))).unwrap();

        assert_eq!(json["online"], serde_json::json!(true));
        assert_eq!(json["power"], serde_json::json!(true));
        assert_eq!(json["mode"], serde_json::json!("cool"));
        assert_eq!(json["targetTemp"], serde_json::json!(24));
        assert_eq!(json["currentTemp"], serde_json::json!(22));
        assert_eq!(json["outdoorTemp"], serde_json::json!(31));
        assert_eq!(json["fanSpeed"], serde_json::json!("high"));
        // `xfan` is the app's name for the protocol's `Blo`.
        assert_eq!(json["xfan"], serde_json::json!(true));
        assert_eq!(json["safetyHeating"], serde_json::json!(false));
        assert_eq!(json["updatedAt"], serde_json::json!("1970-01-01T00:00:00.000Z"));
    }
}

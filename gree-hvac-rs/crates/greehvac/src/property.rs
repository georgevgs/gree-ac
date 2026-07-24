//! Compile-time property model. Replaces the JS runtime reverse-map machinery
//! with an enum carrying its vendor code, plus static value tables. Also owns
//! the friendly <-> vendor conversion used at the HTTP boundary.

use crate::error::{Error, Result};

/// Setpoint bounds the protocol accepts, in °C. Enforced by
/// [`value_to_vendor`] so every write path shares one source of truth.
pub const TEMP_MIN: i64 = 16;
pub const TEMP_MAX: i64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Property {
    Power,
    Mode,
    TemperatureUnit,
    Temperature,
    CurrentTemperature,
    FanSpeed,
    Air,
    Blow,
    Health,
    Sleep,
    Lights,
    SwingHor,
    SwingVert,
    Quiet,
    Turbo,
    PowerSave,
    SafetyHeating,
    /// Outdoor sensor temperature. Not modelled by the JS library; confirmed
    /// live on the UTN/UTG-12CH by probing. Read-only, `+40` encoded.
    OutdoorTemperature,
}

impl Property {
    pub const ALL: [Property; 18] = [
        Property::Power,
        Property::Mode,
        Property::TemperatureUnit,
        Property::Temperature,
        Property::CurrentTemperature,
        Property::FanSpeed,
        Property::Air,
        Property::Blow,
        Property::Health,
        Property::Sleep,
        Property::Lights,
        Property::SwingHor,
        Property::SwingVert,
        Property::Quiet,
        Property::Turbo,
        Property::PowerSave,
        Property::SafetyHeating,
        Property::OutdoorTemperature,
    ];

    /// Protocol field code, e.g. `Pow`.
    pub const fn code(self) -> &'static str {
        use Property::*;
        match self {
            Power => "Pow",
            Mode => "Mod",
            TemperatureUnit => "TemUn",
            Temperature => "SetTem",
            CurrentTemperature => "TemSen",
            FanSpeed => "WdSpd",
            Air => "Air",
            Blow => "Blo",
            Health => "Health",
            Sleep => "SwhSlp",
            Lights => "Lig",
            SwingHor => "SwingLfRig",
            SwingVert => "SwUpDn",
            Quiet => "Quiet",
            Turbo => "Tur",
            PowerSave => "SvSt",
            SafetyHeating => "StHt",
            OutdoorTemperature => "OutEnvTem",
        }
    }

    /// Friendly name used in the JSON API, e.g. `power`.
    pub const fn name(self) -> &'static str {
        use Property::*;
        match self {
            Power => "power",
            Mode => "mode",
            TemperatureUnit => "temperatureUnit",
            Temperature => "temperature",
            CurrentTemperature => "currentTemperature",
            FanSpeed => "fanSpeed",
            Air => "air",
            Blow => "blow",
            Health => "health",
            Sleep => "sleep",
            Lights => "lights",
            SwingHor => "swingHor",
            SwingVert => "swingVert",
            Quiet => "quiet",
            Turbo => "turbo",
            PowerSave => "powerSave",
            SafetyHeating => "safetyHeating",
            OutdoorTemperature => "outdoorTemp",
        }
    }

    pub fn from_code(code: &str) -> Option<Property> {
        use Property::*;
        let p = match code {
            "Pow" => Power,
            "Mod" => Mode,
            "TemUn" => TemperatureUnit,
            "SetTem" => Temperature,
            "TemSen" => CurrentTemperature,
            "WdSpd" => FanSpeed,
            "Air" => Air,
            "Blo" => Blow,
            "Health" => Health,
            "SwhSlp" => Sleep,
            "Lig" => Lights,
            "SwingLfRig" => SwingHor,
            "SwUpDn" => SwingVert,
            "Quiet" => Quiet,
            "Tur" => Turbo,
            "SvSt" => PowerSave,
            "StHt" => SafetyHeating,
            "OutEnvTem" => OutdoorTemperature,
            _ => return None,
        };
        Some(p)
    }

    pub fn from_name(name: &str) -> Option<Property> {
        use Property::*;
        let p = match name {
            "power" => Power,
            "mode" => Mode,
            "temperatureUnit" => TemperatureUnit,
            "temperature" => Temperature,
            "currentTemperature" => CurrentTemperature,
            "fanSpeed" => FanSpeed,
            "air" => Air,
            "blow" => Blow,
            "health" => Health,
            "sleep" => Sleep,
            "lights" => Lights,
            "swingHor" => SwingHor,
            "swingVert" => SwingVert,
            "quiet" => Quiet,
            "turbo" => Turbo,
            "powerSave" => PowerSave,
            "safetyHeating" => SafetyHeating,
            "outdoorTemp" => OutdoorTemperature,
            _ => return None,
        };
        Some(p)
    }

    pub const fn read_only(self) -> bool {
        matches!(
            self,
            Property::CurrentTemperature | Property::OutdoorTemperature
        )
    }
}

/// Enumerated value table, or `None` for raw-numeric properties
/// (temperature, currentTemperature).
fn enum_values(p: Property) -> Option<&'static [(&'static str, i64)]> {
    use Property::*;
    let table: &'static [(&'static str, i64)] = match p {
        Power => &[("off", 0), ("on", 1)],
        Mode => &[
            ("auto", 0),
            ("cool", 1),
            ("dry", 2),
            ("fan_only", 3),
            ("heat", 4),
        ],
        TemperatureUnit => &[("celsius", 0), ("fahrenheit", 1)],
        FanSpeed => &[
            ("auto", 0),
            ("low", 1),
            ("mediumLow", 2),
            ("medium", 3),
            ("mediumHigh", 4),
            ("high", 5),
        ],
        Air => &[("off", 0), ("inside", 1), ("outside", 2), ("mode3", 3)],
        Blow => &[("off", 0), ("on", 1)],
        Health => &[("off", 0), ("on", 1)],
        Sleep => &[("off", 0), ("on", 1)],
        Lights => &[("off", 0), ("on", 1)],
        SwingHor => &[
            ("default", 0),
            ("full", 1),
            ("fixedLeft", 2),
            ("fixedMidLeft", 3),
            ("fixedMid", 4),
            ("fixedMidRight", 5),
            ("fixedRight", 6),
            ("fullAlt", 7),
        ],
        SwingVert => &[
            ("default", 0),
            ("full", 1),
            ("fixedTop", 2),
            ("fixedMidTop", 3),
            ("fixedMid", 4),
            ("fixedMidBottom", 5),
            ("fixedBottom", 6),
            ("swingBottom", 7),
            ("swingMidBottom", 8),
            ("swingMid", 9),
            ("swingMidTop", 10),
            ("swingTop", 11),
        ],
        Quiet => &[("off", 0), ("mode1", 1), ("mode2", 2), ("mode3", 3)],
        Turbo => &[("off", 0), ("on", 1)],
        PowerSave => &[("off", 0), ("on", 1)],
        SafetyHeating => &[("off", 0), ("on", 1)],
        Temperature => return None,
        CurrentTemperature => return None,
        OutdoorTemperature => return None,
    };
    Some(table)
}

/// Vendor integer -> friendly JSON value. Applies the `+40` sensor offset;
/// raw 0 means the unit does not report that sensor. `TemSen` keeps the JS
/// library's convention of reporting the unsupported case as `0`;
/// `OutEnvTem` — which the JS library does not model — reports `null`.
pub fn value_from_vendor(p: Property, raw: i64) -> serde_json::Value {
    if let Property::CurrentTemperature = p {
        let real = if 0 != raw { raw - 40 } else { 0 };
        return serde_json::Value::from(real);
    }

    if let Property::OutdoorTemperature = p {
        return match raw {
            0 => serde_json::Value::Null,
            n => serde_json::Value::from(n - 40),
        };
    }

    match value_name(p, raw) {
        Some(name) => serde_json::Value::from(name),
        None => serde_json::Value::from(raw),
    }
}

/// The enum name for a raw value, e.g. `(Mode, 1) -> "cool"`. `None` for
/// raw-numeric properties, and for a value the table doesn't cover.
pub fn value_name(p: Property, raw: i64) -> Option<&'static str> {
    enum_values(p)?
        .iter()
        .find(|(_, code)| *code == raw)
        .map(|(name, _)| *name)
}

/// Every accepted enum value name for a property, in protocol order; empty for
/// raw-numeric properties. Lets callers build "must be one of: …" errors
/// without duplicating the tables.
pub fn value_names(p: Property) -> Vec<&'static str> {
    enum_values(p)
        .map(|table| table.iter().map(|(name, _)| *name).collect())
        .unwrap_or_default()
}

/// Friendly JSON value -> vendor integer. Accepts either the enum name
/// (`"heat"`) or an integer, but only one the property's value table carries —
/// an arbitrary integer would go on the wire unchecked otherwise. The
/// temperature setpoint is range-checked against [`TEMP_MIN`]/[`TEMP_MAX`].
/// Rejects read-only properties.
pub fn value_to_vendor(p: Property, v: &serde_json::Value) -> Result<i64> {
    if p.read_only() {
        return Err(Error::ReadOnly(p.name()));
    }

    match enum_values(p) {
        Some(table) => {
            if let Some(name) = v.as_str() {
                return table
                    .iter()
                    .find(|(candidate, _)| *candidate == name)
                    .map(|(_, code)| *code)
                    .ok_or_else(|| {
                        Error::UnknownProperty(format!("{}={}", p.name(), name))
                    });
            }
            if let Some(n) = v.as_i64() {
                if table.iter().any(|(_, code)| *code == n) {
                    return Ok(n);
                }
                return Err(Error::UnknownProperty(format!("{}={}", p.name(), n)));
            }
            Err(Error::UnknownProperty(p.name().to_string()))
        }
        None => {
            let n = v
                .as_i64()
                .ok_or_else(|| Error::UnknownProperty(p.name().to_string()))?;
            if let Property::Temperature = p {
                if !(TEMP_MIN..=TEMP_MAX).contains(&n) {
                    return Err(Error::OutOfRange(p.name(), TEMP_MIN, TEMP_MAX));
                }
            }
            Ok(n)
        }
    }
}

/// `{"mode":"heat","temperature":22}` -> `[(Mode,4),(Temperature,22)]`.
pub fn to_vendor(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<(Property, i64)>> {
    obj.iter()
        .map(|(k, v)| {
            let p = Property::from_name(k)
                .ok_or_else(|| Error::UnknownProperty(k.clone()))?;
            Ok((p, value_to_vendor(p, v)?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_and_name_lookup_roundtrip() {
        for p in Property::ALL {
            assert_eq!(Property::from_code(p.code()), Some(p));
            assert_eq!(Property::from_name(p.name()), Some(p));
        }
    }

    #[test]
    fn temsen_offset() {
        assert_eq!(value_from_vendor(Property::CurrentTemperature, 0), serde_json::json!(0));
        assert_eq!(value_from_vendor(Property::CurrentTemperature, 65), serde_json::json!(25));
    }

    #[test]
    fn mode_name_maps_to_code() {
        let out = to_vendor(
            serde_json::json!({"mode": "heat", "temperature": 22})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(out.contains(&(Property::Mode, 4)));
        assert!(out.contains(&(Property::Temperature, 22)));
    }

    #[test]
    fn enum_ints_outside_the_value_table_are_rejected() {
        assert_eq!(value_to_vendor(Property::Mode, &serde_json::json!(4)).unwrap(), 4);
        assert!(value_to_vendor(Property::Mode, &serde_json::json!(999)).is_err());
        assert!(value_to_vendor(Property::FanSpeed, &serde_json::json!(-1)).is_err());
        assert!(value_to_vendor(Property::Power, &serde_json::json!(2)).is_err());
    }

    #[test]
    fn temperature_is_range_checked() {
        assert_eq!(
            value_to_vendor(Property::Temperature, &serde_json::json!(TEMP_MIN)).unwrap(),
            TEMP_MIN
        );
        assert_eq!(
            value_to_vendor(Property::Temperature, &serde_json::json!(TEMP_MAX)).unwrap(),
            TEMP_MAX
        );
        assert!(matches!(
            value_to_vendor(Property::Temperature, &serde_json::json!(TEMP_MIN - 1)),
            Err(Error::OutOfRange(_, _, _))
        ));
        assert!(matches!(
            value_to_vendor(Property::Temperature, &serde_json::json!(86)),
            Err(Error::OutOfRange(_, _, _))
        ));
    }

    #[test]
    fn current_temperature_is_read_only() {
        let err = value_to_vendor(Property::CurrentTemperature, &serde_json::json!(20));
        assert!(matches!(err, Err(Error::ReadOnly(_))));
    }

    #[test]
    fn outdoor_temperature_offset_and_absent_sensor() {
        // A real 0 °C would arrive as 40; raw 0 means "no sensor".
        assert_eq!(
            value_from_vendor(Property::OutdoorTemperature, 0),
            serde_json::Value::Null
        );
        assert_eq!(
            value_from_vendor(Property::OutdoorTemperature, 40),
            serde_json::json!(0)
        );
        assert_eq!(
            value_from_vendor(Property::OutdoorTemperature, 55),
            serde_json::json!(15)
        );
    }

    #[test]
    fn outdoor_temperature_is_read_only() {
        let err = value_to_vendor(Property::OutdoorTemperature, &serde_json::json!(20));
        assert!(matches!(err, Err(Error::ReadOnly(_))));
    }
}

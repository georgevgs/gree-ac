# Reference unit: Toyotomi Umi UTN/UTG-12CH

Everything in this file was measured on the unit this project was built
against. Other GREE-based units share the protocol but differ in which
features actually do something, so treat this as a worked example, not a spec.

| Field | Value |
|-------|-------|
| Model | Toyotomi Umi UTN/UTG-12CH (12000 BTU, A+++/A+++), a GREE rebrand |
| WiFi firmware | v1.45 (AES-GCM encryption) |
| Pairing app | Ewpe Smart |

## Feature notes (GREE protocol names vs. what they do here)

- `health`: GREE's "cold plasma / anion generator". On the Umi this is the
  ionizer, the headline air-quality feature. The PWA labels it "Ionizer".
- `xfan` (GREE `Blo`): keeps the fan running a few minutes after shutdown to
  dry the coil and prevent mildew. Cool/Dry modes only. Marketed as "Auto
  Clean".
- `sleep`: gradually drifts the setpoint overnight (warmer in Cool, cooler in
  Heat).
- `powerSave` (GREE `SvSt`): energy-saving compressor cap. Labeled "Eco".
- `quiet`: progressively lower fan-noise ceilings (`mode1` to `mode3`,
  quietest). Not available in Dry/Fan. `turbo` (max fan) is its opposite;
  don't expect both.
- `safetyHeating` (GREE `StHt`): 8°C anti-freeze heating. Holds an empty room
  near 8°C so it doesn't freeze. A documented Umi feature.
- `air` (fresh-air valve): present in the GREE protocol, but the 12CH is a
  standard wall split with no physical fresh-air damper. On this unit "fresh
  air" is a marketing term for the 56°C self-clean, not ventilation. The API
  still accepts it (`inside` = recirculate, `outside` = exhaust, `mode3` =
  both) in case a future unit has the damper, but the PWA omits the control
  since it does nothing here.
- `outdoorTemp` (GREE `OutEnvTem`, read-only): outdoor sensor temperature in
  the state DTO. No public library models this code; the bridge fetches and
  decodes it as a first-class property (`+40` encoded, same scheme as
  `TemSen`). Confirmed live on the 12CH. `null` when the unit reports no
  sensor.

## What the probe found

Beyond the ~17 codes the public GREE libraries model, this unit also reports:

| Code | Meaning | Status |
|------|---------|--------|
| `OutEnvTem` | Outdoor temperature (read-only sensor) | Wired into the DTO as `outdoorTemp` |
| `Buzzer_ON_OFF` | Command-beep control (app's "Sound") | Readable, but not writable; see below |
| `AntiDirectBlow` | Deflect airflow away from people | Reported (0); no remote/app button; inert |
| `AutoClean` | Auto-clean / coil-dry cycle | Reported (0); no remote/app button; inert |
| `UvcControl` | UV-C sterilization control | Reported (0); no remote/app button; inert |
| `LigSen` | Display auto-dim light sensor | Reported (0) |
| `SlpMod` | Sleep-curve mode selector | Reported (0) |
| `DwatSen` | Drain-water fault sensor | Reported (0) |

Findings from mapping the physical remote and the Ewpe/GREE+ app against the
live protocol (press a button, watch what flips):

- Every control the remote and the vendor app expose, the bridge already
  covers: power, mode, fan, quiet, turbo, swings including fixed angles,
  light, X-Fan, health/ionizer, 8°C heat, eco, sleep, °C/°F.
- No `SelfClean` or `iFeel` code exists here. i-Sense produced zero protocol
  change (remote-only), and neither the remote nor the app has a self-clean
  button. `AntiDirectBlow`, `AutoClean`, and `UvcControl` are reported but
  have no button in either the remote or the app, so they're inert and not
  wired up. That's the fresh-air lesson: a reported code that moves nothing.
- `Buzzer_ON_OFF` (the app's "Sound" beep toggle) is readable and flips when
  toggled from the app, but writes to it via the generic path don't stick,
  neither standalone nor bundled with a command. It needs the exact Ewpe
  payload (probably a `BuzzerCtrl` companion), which isn't cracked, so it's
  deliberately not exposed rather than shipped as a dead toggle.

## No consumption data

This unit reports no power, current, voltage, or compressor-frequency code
over the GREE protocol. Every candidate (`Watt`, `EnLen`, `Curr`, `CmpFrq`,
`Freq`, `OutFrq`, ...) is absent, and a large multi-column `status` request
just gets truncated back to the 17 core codes. Real consumption can't be read
over WiFi on this unit.

The bridge used to ship a modelled estimate, but checked against a real meter
it was too far off to be useful, so it was removed entirely. For real numbers,
add an inline meter: a Shelly EM with a CT clamp on the AC circuit, or a
Shelly PM plug.

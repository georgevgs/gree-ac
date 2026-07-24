import type { Mode, FanSpeed, Quiet, Air, Unit, ToggleField } from './api/types';
import type { IconName } from './components/Icon';
import type { ThemePref } from './hooks/useTheme';

/** What the app calls the unit ("Umi", "Living room"…). Build-time via
 *  VITE_DEVICE_NAME in pwa/.env; the generic default suits any GREE-based AC. */
export const DEVICE_NAME = import.meta.env.VITE_DEVICE_NAME || 'AC';

/** Setpoint range the unit accepts (°C) — shared by the Dial, the stepper, and
 *  the API boundary's clamp. */
export const TEMP_MIN = 16;
export const TEMP_MAX = 30;

// Display definitions for every control. Values mirror the bridge's allow-lists
// (fixed by the gree-hvac-client version); labels are what the user sees.

export const MODE_OPTIONS: { key: Mode; label: string; icon: IconName }[] = [
  { key: 'cool', label: 'Cool', icon: 'cool' },
  { key: 'heat', label: 'Heat', icon: 'heat' },
  { key: 'dry', label: 'Dry', icon: 'dry' },
  { key: 'fan_only', label: 'Fan', icon: 'fan' },
  { key: 'auto', label: 'Auto', icon: 'auto' },
];

export const FAN_OPTIONS: { key: FanSpeed; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'low', label: 'Low' },
  { key: 'mediumLow', label: 'Low+' },
  { key: 'medium', label: 'Med' },
  { key: 'mediumHigh', label: 'Med+' },
  { key: 'high', label: 'High' },
];

export const QUIET_OPTIONS: { key: Quiet; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'mode1', label: '1' },
  { key: 'mode2', label: '2' },
  { key: 'mode3', label: '3' },
];

export const AIR_OPTIONS: { key: Air; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'inside', label: 'Fresh in' },
  { key: 'outside', label: 'Exhaust' },
  { key: 'mode3', label: 'Both' },
];

export const UNIT_OPTIONS: { key: Unit; label: string }[] = [
  { key: 'celsius', label: '°C' },
  { key: 'fahrenheit', label: '°F' },
];

export const THEME_OPTIONS: { key: ThemePref; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

// Airflow louvre zones, one per beam in the AirflowPicker diagrams. Order runs
// top→bottom / left→right to match the fan of beams. `fixed` aims steadily at
// the zone; `swing` (vertical only) sweeps within it. The axis-wide values
// 'default' (off) and 'full' (full sweep) sit outside the zone list.

export interface AirflowZone {
  fixed: string;
  swing?: string;
  label: string;
}

export const AIRFLOW_VERT_ZONES: AirflowZone[] = [
  { fixed: 'fixedTop', swing: 'swingTop', label: 'Top' },
  { fixed: 'fixedMidTop', swing: 'swingMidTop', label: 'Upper' },
  { fixed: 'fixedMid', swing: 'swingMid', label: 'Middle' },
  { fixed: 'fixedMidBottom', swing: 'swingMidBottom', label: 'Lower' },
  { fixed: 'fixedBottom', swing: 'swingBottom', label: 'Bottom' },
];

export const AIRFLOW_HOR_ZONES: AirflowZone[] = [
  { fixed: 'fixedLeft', label: 'Left' },
  { fixed: 'fixedMidLeft', label: 'Center-left' },
  { fixed: 'fixedMid', label: 'Center' },
  { fixed: 'fixedMidRight', label: 'Center-right' },
  { fixed: 'fixedRight', label: 'Right' },
];

// `modes` restricts a feature to those modes; the tile disables elsewhere.
export const TOGGLE_OPTIONS: { key: ToggleField; label: string; icon: IconName; modes?: Mode[] }[] = [
  { key: 'lights', label: 'Light', icon: 'bulb' },
  { key: 'turbo', label: 'Turbo', icon: 'bolt' },
  { key: 'sleep', label: 'Sleep', icon: 'moon' },
  { key: 'xfan', label: 'X-Fan', icon: 'rotor' },
  // GREE "Health" = the anion/cold-plasma generator, i.e. this unit's ionizer.
  { key: 'health', label: 'Ionizer', icon: 'sparkles' },
  // No powerSave here: Eco already has its own quick row on the Home screen.
  // GREE "StHt": anti-freeze heating that holds the room near 8°C.
  { key: 'safetyHeating', label: '8°C Heat', icon: 'thermo', modes: ['heat'] },
];

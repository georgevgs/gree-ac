export type Mode = 'auto' | 'cool' | 'heat' | 'dry' | 'fan_only';
export type FanSpeed = 'auto' | 'low' | 'mediumLow' | 'medium' | 'mediumHigh' | 'high';
export type Quiet = 'off' | 'mode1' | 'mode2' | 'mode3';
export type Air = 'off' | 'inside' | 'outside' | 'mode3';
export type Unit = 'celsius' | 'fahrenheit';

/** Boolean on/off feature fields (keys must match ACState field names). */
export type ToggleField =
  | 'lights'
  | 'turbo'
  | 'sleep'
  | 'xfan'
  | 'health'
  | 'powerSave'
  | 'safetyHeating';

/** Shape returned by the bridge's GET /api/state (kept in sync with the bridge DTO). */
export interface ACState {
  online: boolean;
  power: boolean;
  mode: Mode | null;
  targetTemp: number | null;
  currentTemp: number | null;
  outdoorTemp: number | null;
  fanSpeed: FanSpeed | null;
  swingVert: string | null;
  swingHor: string | null;
  air: Air | null;
  lights: boolean;
  turbo: boolean;
  quiet: Quiet | null;
  health: boolean;
  xfan: boolean;
  sleep: boolean;
  powerSave: boolean;
  safetyHeating: boolean;
  unit: Unit | null;
  updatedAt: string | null;
}

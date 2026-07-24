import type { ACState, Mode } from './api/types';

// Dev-only preview states. Append ?demo=cool|heat|dry|fan|auto|off|offline
// (or swing-aim|swing-sweep|swing-full for the airflow picker) to the dev URL
// to render the UI in that state without a live bridge — handy for design work
// and screenshots. Stripped from production: readDemoState() returns null
// unless import.meta.env.DEV is true, so `npm run build` never ships it.

const BASE: ACState = {
  online: true,
  power: true,
  mode: 'cool',
  targetTemp: 24,
  currentTemp: 21,
  outdoorTemp: 15,
  fanSpeed: 'auto',
  swingVert: 'default',
  swingHor: 'default',
  air: 'off',
  lights: true,
  turbo: false,
  quiet: 'off',
  health: true,
  xfan: false,
  sleep: false,
  powerSave: false,
  safetyHeating: false,
  unit: 'celsius',
  updatedAt: null,
};

const MODES: Record<string, Mode> = {
  cool: 'cool',
  heat: 'heat',
  dry: 'dry',
  fan: 'fan_only',
  auto: 'auto',
};

export function readDemoState(): ACState | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const d = new URLSearchParams(window.location.search).get('demo');
  if (!d) return null;

  if (d === 'off') return { ...BASE, power: false };
  if (d === 'offline') return { ...BASE, online: false };
  if (d === 'swing-aim') return { ...BASE, swingVert: 'fixedMidTop', swingHor: 'fixedMidLeft' };
  if (d === 'swing-sweep') return { ...BASE, swingVert: 'swingTop', swingHor: 'fixedMid' };
  if (d === 'swing-full') return { ...BASE, swingVert: 'full', swingHor: 'full' };
  if (d in MODES) return { ...BASE, mode: MODES[d], targetTemp: d === 'heat' ? 23 : 24 };
  return BASE;
}

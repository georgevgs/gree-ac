import { AcError } from './api/acClient';
import type { ACState, Mode } from './api/types';

// Dev-only preview states. Append ?demo=<name> to the dev URL to render the UI
// in that state without a live bridge — handy for design work and screenshots.
// Stripped from production: readDemo() returns null unless import.meta.env.DEV
// is true, so `npm run build` never ships it.
//
//   cool | heat | dry | fan | auto     the five running modes
//   off | offline                      standby, and the unit unreachable
//   swing-aim | swing-sweep | swing-full   the airflow picker
//   connecting                         before the first reading lands
//   error-bridge | error-auth          the two failure banners
//   error-command                      a write that did not land

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

/** A frozen preview: what the hook would be holding in that situation. `state`
 *  null means no reading has arrived yet, which is what drives the connecting
 *  phase. */
export interface Demo {
  state: ACState | null;
  /** A read failure — the subtitle and status dot render from this. */
  error: AcError | null;
  /** A write failure — the banner renders from this. */
  commandError: AcError | null;
}

export function readDemo(): Demo | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const d = new URLSearchParams(window.location.search).get('demo');
  if (!d) return null;

  const frozen = (state: ACState | null, error: AcError | null = null, commandError: AcError | null = null): Demo => ({
    state,
    error,
    commandError,
  });

  if (d === 'connecting') return frozen(null);
  if (d === 'error-bridge') return frozen(null, new AcError('network', 'Network request failed'));
  if (d === 'error-auth') return frozen(null, new AcError('auth', 'invalid or missing token'));
  if (d === 'error-command') {
    return frozen(BASE, null, new AcError('ac-offline', 'AC unreachable'));
  }
  if (d === 'off') return frozen({ ...BASE, power: false });
  if (d === 'offline') return frozen({ ...BASE, online: false });
  if (d === 'swing-aim') {
    return frozen({ ...BASE, swingVert: 'fixedMidTop', swingHor: 'fixedMidLeft' });
  }
  if (d === 'swing-sweep') return frozen({ ...BASE, swingVert: 'swingTop', swingHor: 'fixedMid' });
  if (d === 'swing-full') return frozen({ ...BASE, swingVert: 'full', swingHor: 'full' });
  // hasOwn, not `in`: `in` walks the prototype chain, so ?demo=constructor
  // would pass the check and put Object's constructor into `mode`, which then
  // indexes the Record<Mode, ...> lookups in theme.ts.
  if (Object.hasOwn(MODES, d)) {
    return frozen({ ...BASE, mode: MODES[d], targetTemp: d === 'heat' ? 23 : 24 });
  }
  return frozen(BASE);
}

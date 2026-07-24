import type { ACState, Mode, FanSpeed, Quiet, Air, Unit } from './types';

// Empty VITE_BRIDGE_URL => same origin (bridge serves the PWA). Otherwise the
// Tailscale hostname or LAN IP of the bridge, e.g. http://192.168.1.50:8481
const BASE = (import.meta.env.VITE_BRIDGE_URL ?? '').replace(/\/$/, '') + '/api';

// Allow-lists for every server enum. A value outside them (a newer bridge, a
// firmware quirk) collapses to null at the boundary and renders as "—",
// instead of reaching a Record lookup that would crash the app.
const MODES: readonly Mode[] = ['auto', 'cool', 'heat', 'dry', 'fan_only'];
const FAN_SPEEDS: readonly FanSpeed[] = ['auto', 'low', 'mediumLow', 'medium', 'mediumHigh', 'high'];
const QUIET_LEVELS: readonly Quiet[] = ['off', 'mode1', 'mode2', 'mode3'];
const AIR_MODES: readonly Air[] = ['off', 'inside', 'outside', 'mode3'];
const UNITS: readonly Unit[] = ['celsius', 'fahrenheit'];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

/** The single trust boundary: bridge JSON is loose outside, strict inside.
 *  Absent and null normalize the same way, unknown fields are ignored, and
 *  unknown enum values become null — nothing downstream re-checks shapes. */
function normalizeState(raw: unknown): ACState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    online: r.online === true,
    power: r.power === true,
    mode: oneOf(MODES, r.mode),
    targetTemp: finiteNumber(r.targetTemp),
    currentTemp: finiteNumber(r.currentTemp),
    outdoorTemp: finiteNumber(r.outdoorTemp),
    fanSpeed: oneOf(FAN_SPEEDS, r.fanSpeed),
    swingVert: nullableString(r.swingVert),
    swingHor: nullableString(r.swingHor),
    air: oneOf(AIR_MODES, r.air),
    lights: r.lights === true,
    turbo: r.turbo === true,
    quiet: oneOf(QUIET_LEVELS, r.quiet),
    health: r.health === true,
    xfan: r.xfan === true,
    sleep: r.sleep === true,
    powerSave: r.powerSave === true,
    safetyHeating: r.safetyHeating === true,
    unit: oneOf(UNITS, r.unit),
    updatedAt: nullableString(r.updatedAt),
  };
}

// Every bridge endpoint answers with the full fresh state, so this is not
// generic: one request path, one normalization point.
async function req(path: string, init?: RequestInit): Promise<ACState> {
  const res = await fetch(BASE + path, {
    cache: 'no-store', // never reuse a cached AC state reading
    signal: AbortSignal.timeout(8000), // don't let a hung request stack up
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    let message = `Request failed: ${res.status}`;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const detail = (body as { error: unknown }).error;
      if (typeof detail === 'string' && detail !== '') {
        message = detail;
      }
    }
    throw new Error(message);
  }
  return normalizeState(await res.json());
}

/**
 * Subscribe to the bridge's push stream. The daemon sends the current state on
 * connect and again on every change, so a change made from the physical remote
 * lands here in milliseconds instead of waiting for the next poll.
 *
 * `EventSource` reconnects on its own; `onDrop` fires each time the connection
 * breaks, so the caller can fall back to polling until it recovers. Returns an
 * unsubscribe function.
 */
export function subscribeState(
  onState: (state: ACState) => void,
  onDrop: () => void,
): () => void {
  const source = new EventSource(BASE + '/events');

  source.onmessage = (event: MessageEvent<string>) => {
    try {
      onState(normalizeState(JSON.parse(event.data)));
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  };
  source.onerror = () => onDrop();

  return () => source.close();
}

export const acClient = {
  getState: () => req('/state'),
  setPower: (on: boolean) =>
    req('/power', { method: 'POST', body: JSON.stringify({ on }) }),
  setTemp: (temp: number) =>
    req('/temp', { method: 'POST', body: JSON.stringify({ temp }) }),
  setMode: (mode: Mode) =>
    req('/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  setFan: (speed: FanSpeed) =>
    req('/fan', { method: 'POST', body: JSON.stringify({ speed }) }),
  setSwing: (vert?: string, hor?: string) =>
    req('/swing', { method: 'POST', body: JSON.stringify({ vert, hor }) }),
  setOption: (key: string, value: boolean | string) =>
    req('/option', { method: 'POST', body: JSON.stringify({ key, value }) }),
};

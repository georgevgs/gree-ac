import type { ACState, Mode, FanSpeed, Quiet, Air, ToggleField, Unit } from './types';
import { AIRFLOW_VERT_ZONES, AIRFLOW_HOR_ZONES, TEMP_MIN, TEMP_MAX, type AirflowZone } from '../options';

// Empty VITE_BRIDGE_URL => same origin (bridge serves the PWA). Otherwise the
// Tailscale hostname or LAN IP of the bridge, e.g. http://192.168.1.50:8481
const ORIGIN = (import.meta.env.VITE_BRIDGE_URL ?? '').replace(/\/$/, '');
const BASE = ORIGIN + '/api';

/** Host the API is actually reached at, for display. Settings used to show
 *  `window.location.host`, which is where the *app* was served from: during
 *  development that is the Vite dev server, so the row named the wrong machine. */
export function bridgeHost(): string {
  try {
    return new URL(ORIGIN === '' ? window.location.href : ORIGIN).host;
  } catch {
    return window.location.host;
  }
}

/** Writable options, split by value type so a typo cannot reach the bridge and
 *  come back a 400. Mirrors TOGGLE_KEYS / ENUM_KEYS in the daemon's api.rs. */
interface SetOption {
  (key: ToggleField, value: boolean): Promise<ACState>;
  (key: 'quiet', value: Quiet): Promise<ACState>;
  (key: 'air', value: Air): Promise<ACState>;
  (key: 'unit', value: Unit): Promise<ACState>;
}

/** Why a request failed, at the granularity the UI acts on: `network` and
 *  `timeout` mean the bridge itself is unreachable, `ac-offline` means the
 *  bridge answered but the unit is away (503), `rejected` is a validation 400,
 *  `auth` a 401 (token needed — see Settings), `server` everything else. */
export type AcErrorKind = 'network' | 'timeout' | 'ac-offline' | 'rejected' | 'auth' | 'server';

export class AcError extends Error {
  constructor(
    readonly kind: AcErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AcError';
  }
}

/** Everything this module throws is an AcError; this narrows the rest. */
export function toAcError(e: unknown): AcError {
  if (e instanceof AcError) {
    return e;
  }
  if (e instanceof Error) {
    return new AcError('server', e.message);
  }
  return new AcError('server', 'Request failed');
}

// Optional bridge auth. The token lives in localStorage (set in Settings);
// fetches carry it as a Bearer header, the SSE URL as ?token= because
// EventSource cannot send headers.
const TOKEN_KEY = 'bridgeToken';

export function readToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

const TOKEN_EVENT = 'ac:token-change';

export function writeToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed === '') {
    localStorage.removeItem(TOKEN_KEY);
  } else {
    localStorage.setItem(TOKEN_KEY, trimmed);
  }
  window.dispatchEvent(new Event(TOKEN_EVENT));
}

/**
 * Run `fn` whenever the saved token changes.
 *
 * Fetches read the token per request, so they pick a new one up immediately.
 * The SSE stream cannot: the token is baked into the `EventSource` URL at
 * connect time, so without this a token typed into Settings left the stream
 * retrying the old URL and 401ing until the app was next backgrounded, with
 * live updates silently degraded to the poll in the meantime.
 */
export function onTokenChange(fn: () => void): () => void {
  const fromOtherTab = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === null) fn();
  };
  window.addEventListener(TOKEN_EVENT, fn);
  window.addEventListener('storage', fromOtherTab);
  return () => {
    window.removeEventListener(TOKEN_EVENT, fn);
    window.removeEventListener('storage', fromOtherTab);
  };
}

// Allow-lists for every server enum. A value outside them (a newer bridge, a
// firmware quirk) collapses to null at the boundary and renders as "—",
// instead of reaching a Record lookup that would crash the app.
const MODES: readonly Mode[] = ['auto', 'cool', 'heat', 'dry', 'fan_only'];
const FAN_SPEEDS: readonly FanSpeed[] = ['auto', 'low', 'mediumLow', 'medium', 'mediumHigh', 'high'];
const QUIET_LEVELS: readonly Quiet[] = ['off', 'mode1', 'mode2', 'mode3'];
const AIR_MODES: readonly Air[] = ['off', 'inside', 'outside', 'mode3'];
const UNITS: readonly Unit[] = ['celsius', 'fahrenheit'];

// Swing values the AirflowPicker understands: the axis-wide 'default' (off)
// and 'full' plus each zone's fixed and (vertical only) swing position.
function swingValues(zones: readonly AirflowZone[]): readonly string[] {
  return ['default', 'full', ...zones.flatMap((z) => (z.swing ? [z.fixed, z.swing] : [z.fixed]))];
}
const SWING_VERT = swingValues(AIRFLOW_VERT_ZONES);
const SWING_HOR = swingValues(AIRFLOW_HOR_ZONES);

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

// The setpoint is bounded here so an out-of-range reading can never push the
// Dial past its arc; the current/outdoor readings stay as reported.
function boundedTemp(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null) {
    return null;
  }
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, n));
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
    targetTemp: boundedTemp(r.targetTemp),
    currentTemp: finiteNumber(r.currentTemp),
    outdoorTemp: finiteNumber(r.outdoorTemp),
    fanSpeed: oneOf(FAN_SPEEDS, r.fanSpeed),
    swingVert: oneOf(SWING_VERT, r.swingVert),
    swingHor: oneOf(SWING_HOR, r.swingHor),
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
// generic: one request path, one normalization point. Every failure leaves
// as a typed AcError, never a bare Error.
async function req(path: string, init?: RequestInit): Promise<ACState> {
  const headers: Record<string, string> = {};
  if (init?.body != null) {
    headers['Content-Type'] = 'application/json';
  }
  const token = readToken();
  if (token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      cache: 'no-store', // never reuse a cached AC state reading
      signal: AbortSignal.timeout(8000), // don't let a hung request stack up
      headers,
      ...init,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new AcError('timeout', 'Request timed out');
    }
    throw new AcError('network', 'Network request failed');
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    let message = `Request failed: ${res.status}`;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const detail = (body as { error: unknown }).error;
      if (typeof detail === 'string' && detail !== '') {
        message = detail;
      }
    }
    if (res.status === 503) {
      throw new AcError('ac-offline', message);
    }
    if (res.status === 400) {
      throw new AcError('rejected', message);
    }
    if (res.status === 401) {
      throw new AcError('auth', message);
    }
    throw new AcError('server', message);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AcError('server', 'Malformed response from the bridge');
  }
  return normalizeState(body);
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
  const token = readToken();
  let url = BASE + '/events';
  if (token !== '') {
    url += '?token=' + encodeURIComponent(token);
  }
  const source = new EventSource(url);

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
  setOption: ((key, value) =>
    req('/option', { method: 'POST', body: JSON.stringify({ key, value }) })) as SetOption,
};

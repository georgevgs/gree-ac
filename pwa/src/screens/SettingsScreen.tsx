import { useState } from 'react';
import type { ACState, Unit } from '../api/types';
import { acClient, readToken, writeToken } from '../api/acClient';
import { DEVICE_NAME, UNIT_OPTIONS, THEME_OPTIONS } from '../options';
import type { ThemePref } from '../hooks/useTheme';
import { Icon } from '../components/Icon';
import { Row } from '../components/Row';
import { Segmented } from '../components/Segmented';

interface Props {
  state: ACState | null;
  command: (fn: () => Promise<ACState>) => Promise<void>;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
}

/** Settings per the design: device card, Preferences, System. App appearance
 *  lives here (not a unit control); no accounts, so no sign-out. */
export function SettingsScreen({ state, command, theme, setTheme }: Props) {
  const online = !!state?.online;
  // Availability only — never dims for an in-flight write (see useACState).
  const disabled = !state || !online;

  return (
    <div className="flex flex-col">
      <h1 className="mb-5 px-0.5 text-[30px] font-extrabold tracking-[-0.02em] text-text">
        Settings
      </h1>

      {/* Device card */}
      <div className="card mb-6 flex items-center gap-3.5 px-[18px] py-4" style={{ boxShadow: 'var(--shadow-card)' }}>
        <span
          className="flex h-[52px] w-[52px] items-center justify-center rounded-2xl"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}
        >
          <Icon name="cool" size={26} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-bold text-text">{DEVICE_NAME}</span>
          <span className="block text-[13px] text-t2">GREE-compatible unit</span>
        </span>
        <span
          className="flex items-center gap-1.5 text-[12px] font-semibold"
          style={{ color: online ? 'var(--green-600)' : 'var(--warning-500)' }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: online ? 'var(--accent)' : 'var(--warning-500)' }}
          />
          {online ? 'Connected' : 'Offline'}
        </span>
      </div>

      <div className="label-mono mb-2.5 px-0.5">Preferences</div>
      <div className="card mb-6 overflow-hidden">
        <Row
          icon="moon"
          label="Appearance"
          divider
          right={
            <Segmented<ThemePref>
              items={THEME_OPTIONS}
              value={theme}
              label="Appearance"
              onChange={setTheme}
            />
          }
        />
        {/* Switches what the AC's own panel shows — the app always works in °C,
            since that's what the bridge reports. */}
        <Row
          icon="thermo"
          label="Panel display"
          right={
            <Segmented<Unit>
              items={UNIT_OPTIONS}
              value={state?.unit ?? null}
              disabled={disabled}
              label="Temperature unit shown on the AC unit"
              onChange={(u) => command(() => acClient.setOption('unit', u))}
            />
          }
        />
      </div>

      <div className="label-mono mb-2.5 px-0.5">System</div>
      <div className="card overflow-hidden">
        <Row icon="wifi" label="Bridge" divider right={window.location.host || '—'} />
        <Row icon="key" label="Token" divider right={<TokenField />} />
        <Row icon="info" label="Version" right={`v${__APP_VERSION__} · ${__BUILD_DATE__}`} />
      </div>
    </div>
  );
}

/** Masked entry for the bridge's optional access token — only needed when the
 *  bridge was started with one. Saved as typed; leaving it empty clears it. */
function TokenField() {
  const [token, setToken] = useState(() => readToken());
  return (
    <input
      type="password"
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      placeholder="None"
      aria-label="Bridge token"
      value={token}
      onChange={(e) => {
        setToken(e.target.value);
        writeToken(e.target.value);
      }}
      onBlur={() => setToken((v) => v.trim())}
      className="w-[140px] border-none bg-transparent text-right text-[14px] text-t2 placeholder:text-t3"
    />
  );
}

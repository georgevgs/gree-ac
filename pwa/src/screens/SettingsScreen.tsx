import type { ACState, Unit } from '../api/types';
import { acClient } from '../api/acClient';
import { UNIT_OPTIONS, THEME_OPTIONS } from '../options';
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
          <span className="block text-[17px] font-bold text-text">Umi</span>
          <span className="block text-[13px] text-t2">Toyotomi wall unit</span>
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
        <Row
          icon="thermo"
          label="Unit"
          right={
            <Segmented<Unit>
              items={UNIT_OPTIONS}
              value={state?.unit ?? null}
              disabled={disabled}
              label="Temperature unit"
              onChange={(u) => command(() => acClient.setOption('unit', u))}
            />
          }
        />
      </div>

      <div className="label-mono mb-2.5 px-0.5">System</div>
      <div className="card overflow-hidden">
        <Row icon="wifi" label="Bridge" divider right={window.location.host || '—'} />
        <Row icon="info" label="Version" right={`v${__APP_VERSION__} · ${__BUILD_DATE__}`} />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { acClient } from '../api/acClient';
import type { AcError } from '../api/acClient';
import type { ACState, Mode, Quiet } from '../api/types';
import { DEVICE_NAME, MODE_OPTIONS, FAN_OPTIONS, QUIET_OPTIONS, TEMP_MIN, TEMP_MAX } from '../options';
import { HELP, type HelpEntry } from '../help';
import { Dial } from '../components/Dial';
import { PowerToggle } from '../components/PowerToggle';
import { ModeTiles } from '../components/ModeTiles';
import { FanSlider } from '../components/FanSlider';
import { StatTiles } from '../components/StatTiles';
import { Row } from '../components/Row';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';
import { AirflowPicker } from '../components/AirflowPicker';
import { FeatureTiles } from '../components/FeatureTiles';
import { InfoButton } from '../components/InfoButton';
import { HelpPanel } from '../components/HelpPanel';
import { Icon } from '../components/Icon';

// Minimum gap between setpoint commits while tapping +/−. The first tap in a
// burst sends immediately; only follow-ups inside this window coalesce into one
// trailing send. Well above a LAN round trip (~70 ms), so spaced sends cannot
// arrive at the bridge out of order.
const COMMIT_SPACING_MS = 450;

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 30 } },
} as const;

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
} as const;

interface Props {
  state: ACState | null;
  error: AcError | null;
  command: (fn: () => Promise<ACState>) => Promise<void>;
}

export function HomeScreen({ state, error, command }: Props) {
  const reduce = useReducedMotion();

  const connecting = !state;
  const online = !!state?.online;
  const offline = state ? !online : false;
  const power = !!state?.power;
  // Controls grey out only when the unit is genuinely unavailable — before the
  // first reading or while offline — never for an in-flight write. The write
  // is optimistic, so there is nothing to wait on.
  const disabled = connecting || offline;
  const controls = disabled || !power; // secondary controls need power on

  // Inline help toggles for the sections that don't use SectionLabel.
  const [tempHelp, setTempHelp] = useState(false);
  const [quietHelp, setQuietHelp] = useState(false);

  // Optimistic setpoint: +/− taps update instantly. The first tap of a burst
  // commits right away — the unit beeps as fast as it can hear us — and rapid
  // follow-ups coalesce into one trailing commit, latest value wins. The held
  // value drops once the bridge confirms it (or after a safety window if it
  // never does).
  const [held, setHeld] = useState<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  const lastCommitAt = useRef(0);
  const shownTemp = held ?? state?.targetTemp ?? null;

  useEffect(() => {
    if (held != null && state?.targetTemp === held) setHeld(null);
  }, [state?.targetTemp, held]);
  useEffect(() => {
    if (held == null) return;
    const t = window.setTimeout(() => setHeld(null), 6000);
    return () => window.clearTimeout(t);
  }, [held]);

  const step = (delta: number) => {
    const base = held ?? state?.targetTemp;
    if (base == null) return;
    const t = Math.min(TEMP_MAX, Math.max(TEMP_MIN, base + delta));
    if (t === base && t !== TEMP_MIN && t !== TEMP_MAX) return;
    setHeld(t);
    const commit = () => {
      lastCommitAt.current = Date.now();
      void command(() => acClient.setTemp(t));
    };
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    const wait = lastCommitAt.current + COMMIT_SPACING_MS - Date.now();
    if (wait <= 0) commit();
    else commitTimer.current = window.setTimeout(commit, wait);
  };

  // Like the physical remote: picking a mode while the unit is off wakes it.
  const selectMode = (mode: Mode) =>
    command(async () => {
      const s = await acClient.setMode(mode);
      return power ? s : acClient.setPower(true);
    });

  const subtitle = subtitleFor(state, error);

  return (
    <m.div
      variants={container}
      initial={reduce ? false : 'hidden'}
      animate="show"
      className="flex flex-col gap-[15px]"
    >
      <m.header variants={item} className="flex items-start justify-between px-0.5">
        <div className="flex flex-col gap-[3px]">
          <span className="label-mono">{todayLabel()}</span>
          <h1 className="mt-[3px] text-[27px] font-extrabold tracking-[-0.02em] text-text">
            {DEVICE_NAME}
          </h1>
          <p role="status" className="flex items-center gap-1.5 text-[13px] text-t2">
            <StatusDot connecting={connecting} error={error} offline={offline} power={power} />
            {subtitle}
          </p>
        </div>
        <PowerToggle
          power={power}
          disabled={disabled}
          onToggle={(on) => command(() => acClient.setPower(on))}
        />
      </m.header>

      {/* Everything below fades toward standby when the unit is off/unreachable. */}
      <div
        className="flex flex-col gap-[15px]"
        style={{ opacity: !connecting && (!power || offline) ? 0.55 : 1, transition: 'opacity 0.35s ease' }}
      >
        <m.section variants={item} className="mb-1 mt-2">
          <Dial
            temp={shownTemp}
            current={state?.currentTemp ?? null}
            mode={state?.mode ?? null}
            power={power}
            online={connecting ? null : online}
            min={TEMP_MIN}
            max={TEMP_MAX}
          />
        </m.section>

        {/* Stepper */}
        <m.section variants={item}>
          <div className="flex items-center justify-center gap-5">
            <StepButton dir={-1} disabled={controls} onStep={step} />
            <span className="flex items-center gap-1.5">
              <span className="label-mono">Set temp</span>
              <InfoButton
                open={tempHelp}
                onToggle={() => setTempHelp((v) => !v)}
                label="Temperature"
              />
            </span>
            <StepButton dir={1} disabled={controls} onStep={step} />
          </div>
          <AnimatePresence initial={false}>
            {tempHelp && <HelpPanel entry={HELP.temp} />}
          </AnimatePresence>
        </m.section>

        <SectionLabel title="Mode" help={HELP.mode}>
          <ModeTiles
            value={power && online ? (state?.mode ?? null) : null}
            disabled={disabled}
            onSelect={selectMode}
          />
        </SectionLabel>

        <m.section variants={item}>
          <FanSlider
            value={state?.fanSpeed ?? null}
            disabled={controls}
            onChange={(f) => command(() => acClient.setFan(f))}
            help={HELP.fan}
          />
        </m.section>

        <m.section variants={item}>
          <StatTiles outdoor={state?.outdoorTemp ?? null} indoor={state?.currentTemp ?? null} />
        </m.section>

        {/* Quick rows */}
        <m.section variants={item} className="card overflow-hidden">
          <Row
            icon="leaf"
            label="Eco mode"
            divider
            right={
              <Switch
                on={!!state?.powerSave}
                disabled={controls}
                label="Eco mode"
                onToggle={(on) => command(() => acClient.setOption('powerSave', on))}
              />
            }
          />
          <Row
            icon="moon"
            label="Quiet"
            info={
              <InfoButton
                open={quietHelp}
                onToggle={() => setQuietHelp((v) => !v)}
                label="Quiet"
              />
            }
            right={
              <Segmented<Quiet>
                items={QUIET_OPTIONS}
                value={state?.quiet ?? null}
                disabled={controls}
                label="Quiet"
                onChange={(q) => command(() => acClient.setOption('quiet', q))}
              />
            }
          />
          <AnimatePresence initial={false}>
            {quietHelp && (
              <div className="px-[18px] pb-[15px]">
                <HelpPanel entry={HELP.quiet} />
              </div>
            )}
          </AnimatePresence>
        </m.section>

        <SectionLabel title="Features" help={HELP.features}>
          <FeatureTiles
            values={state}
            mode={state?.mode ?? null}
            disabled={controls}
            onToggle={(key, next) => command(() => acClient.setOption(key, next))}
          />
        </SectionLabel>

        <SectionLabel title="Airflow" help={HELP.swing}>
          <AirflowPicker
            vert={state?.swingVert ?? null}
            hor={state?.swingHor ?? null}
            disabled={controls}
            onSet={(axis, v) =>
              command(() =>
                axis === 'vert' ? acClient.setSwing(v, undefined) : acClient.setSwing(undefined, v),
              )
            }
          />
        </SectionLabel>
      </div>
    </m.div>
  );
}

function StepButton({ dir, disabled, onStep }: { dir: 1 | -1; disabled: boolean; onStep: (d: number) => void }) {
  const plus = dir === 1;
  return (
    <m.button
      type="button"
      aria-label={plus ? 'Warmer' : 'Cooler'}
      disabled={disabled}
      onClick={() => onStep(dir)}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      className="flex h-[58px] w-[58px] items-center justify-center rounded-full disabled:opacity-40"
      style={
        plus
          ? { background: 'var(--accent)', color: 'var(--on-accent)', boxShadow: 'var(--glow-accent)' }
          : { background: 'var(--surface)', color: 'var(--text)', boxShadow: 'var(--shadow-sm)' }
      }
    >
      <Icon name={plus ? 'plus' : 'minus'} size={26} strokeWidth={2.1} />
    </m.button>
  );
}

/** Mono section kicker with an optional ⓘ toggling its help entry. */
function SectionLabel({ title, help, children }: { title: string; help?: HelpEntry; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <m.section variants={item}>
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <span className="label-mono">{title}</span>
        {help && <InfoButton open={open} onToggle={() => setOpen((v) => !v)} label={title} />}
      </div>
      {help && (
        <AnimatePresence initial={false}>
          {open && (
            <div className="mb-2.5">
              <HelpPanel entry={help} />
            </div>
          )}
        </AnimatePresence>
      )}
      {children}
    </m.section>
  );
}

/** One line under the title: connection state first, then what's running. */
function subtitleFor(state: ACState | null, error: AcError | null): string {
  if (error) {
    const base = errorSubtitle(error);
    if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'ac-offline') {
      return withLastSeen(base, state);
    }
    return base;
  }
  if (!state) return 'Connecting…';
  if (!state.online) return withLastSeen('Unit offline', state);
  if (!state.power) return 'Standby';
  const mode = MODE_OPTIONS.find((o) => o.key === state.mode)?.label ?? '—';
  const fan = FAN_OPTIONS.find((o) => o.key === state.fanSpeed)?.label.toLowerCase() ?? '—';
  return `${mode} · Fan ${fan}`;
}

function errorSubtitle(error: AcError): string {
  if (error.kind === 'network' || error.kind === 'timeout') return 'Can’t reach the bridge';
  if (error.kind === 'ac-offline') return 'Unit offline';
  if (error.kind === 'auth') return 'Token required — see Settings';
  return error.message;
}

/** "… · as of 14:32": how old the reading on screen is, once it may no longer
 *  be live — what matters when checking remotely whether the heat is on. */
function withLastSeen(base: string, state: ACState | null): string {
  if (!state?.updatedAt) return base;
  const at = new Date(state.updatedAt);
  if (Number.isNaN(at.getTime())) return base;
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return `${base} · as of ${time}`;
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${base} · as of ${day}, ${time}`;
}

/** "Monday · 21 Jul" per the design's header kicker. */
function todayLabel(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${weekday} · ${day}`;
}

function StatusDot({
  connecting,
  error,
  offline,
  power,
}: {
  connecting: boolean;
  error: AcError | null;
  offline: boolean;
  power: boolean;
}) {
  let color = 'var(--accent)';
  if (error && error.kind === 'ac-offline') color = 'var(--warning-500)';
  else if (error) color = 'var(--danger-500)';
  else if (connecting) color = 'var(--text-subtle)';
  else if (offline) color = 'var(--warning-500)';
  else if (!power) color = 'var(--text-subtle)';
  return (
    <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color }} />
  );
}

import { m, useReducedMotion } from 'framer-motion';
import type { Mode } from '../api/types';
import { modeColor, modeGlow, modeStatus } from '../theme';

interface Props {
  /** Shown setpoint — may be an optimistic value mid-adjustment. */
  temp: number | null;
  current: number | null;
  mode: Mode | null;
  power: boolean;
  online: boolean;
  min?: number;
  max?: number;
}

/** The design's centerpiece: a 256px conic-gradient ring that fills with the
 *  mode's color as the setpoint rises, around a raised readout disc. Display
 *  only — the stepper below it adjusts. */
export function Dial({ temp, current, mode, power, online, min = 16, max = 30 }: Props) {
  const reduce = useReducedMotion();
  const active = power && online && mode != null;
  const pct = temp == null ? 0 : Math.round(((temp - min) / (max - min)) * 100);
  const color = active && mode ? modeColor(mode) : 'var(--text-subtle)';

  return (
    <div className="flex justify-center">
      <div
        className="relative h-64 w-64 rounded-full"
        style={{
          background: active && mode
            ? `conic-gradient(${modeColor(mode)} 0 ${pct}%, var(--surface-2) ${pct}% 100%)`
            : 'var(--surface-2)',
          boxShadow: active && mode ? modeGlow(mode) : 'none',
          transition: 'background 0.3s ease, box-shadow 0.4s ease',
        }}
      >
        <div
          className="absolute flex flex-col items-center justify-center rounded-full"
          style={{ inset: 26, background: 'var(--surface)', boxShadow: 'var(--shadow-card)' }}
        >
          <div
            className="label-mono"
            style={{ letterSpacing: '0.12em', color, transition: 'color 0.3s ease' }}
          >
            {modeStatus(mode, power, online)}
          </div>
          <div className="mt-0.5 flex items-start">
            <m.span
              key={temp ?? 'none'}
              initial={reduce ? false : { y: 6, opacity: 0.4 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="tnum text-[80px] font-bold leading-[0.95] tracking-[-0.03em]"
              style={{ color: active ? 'var(--text)' : 'var(--text-subtle)', transition: 'color 0.3s ease' }}
            >
              {temp ?? '––'}
            </m.span>
            <span className="mt-2 text-[24px] font-semibold text-t2">°</span>
          </div>
          <div className="tnum text-[13px] text-t3">
            {current != null ? `Now ${current}°` : 'Now —'}
          </div>
        </div>
      </div>
    </div>
  );
}

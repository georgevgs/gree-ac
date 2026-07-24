import { m, useReducedMotion } from 'framer-motion';
import type { Mode, ToggleField } from '../api/types';
import { MODE_OPTIONS, TOGGLE_OPTIONS } from '../options';
import { Icon } from './Icon';

interface Props {
  /** Current on/off value per feature; null while connecting. */
  values: Partial<Record<ToggleField, boolean>> | null;
  /** Current mode — features that list `modes` only work in those, and their
   *  tiles disable elsewhere (e.g. 8°C Heat is a Heat-mode function). */
  mode: Mode | null;
  disabled?: boolean;
  onToggle: (key: ToggleField, next: boolean) => void;
}

/** "Heat only" — shown in place of On/Off when the mode doesn't support it. */
function modesHint(modes: Mode[]): string {
  return `${modes.map((m) => MODE_OPTIONS.find((o) => o.key === m)?.label ?? m).join(' / ')} only`;
}

/** The feature switches as a small control centre: a grid of tappable tiles,
 *  each with an icon chip, name, and state. An active tile washes in the mode
 *  accent and its chip fills solid, so what's running reads at a glance. */
export function FeatureTiles({ values, mode, disabled, onToggle }: Props) {
  const reduce = useReducedMotion();
  return (
    <div className="grid grid-cols-2 gap-2">
      {TOGGLE_OPTIONS.map((t, i) => {
        const unavailable = !!t.modes && (mode == null || !t.modes.includes(mode));
        const on = !unavailable && !!values?.[t.key];
        // With an odd count, the last tile stretches across so no cell sits empty.
        const stretch = i === TOGGLE_OPTIONS.length - 1 && TOGGLE_OPTIONS.length % 2 === 1;
        return (
          <m.button
            key={t.key}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t.label}
            disabled={disabled || unavailable}
            onClick={() => onToggle(t.key, !on)}
            whileTap={disabled ? undefined : { scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={`flex items-center gap-2.5 rounded-2xl py-2.5 pl-2.5 pr-3 text-left disabled:opacity-40 ${stretch ? 'col-span-2' : ''}`}
            style={{
              background: on ? 'var(--accent-soft)' : 'var(--surface)',
              border: `1px solid ${on ? 'transparent' : 'var(--card-border)'}`,
              transition: 'background 0.25s ease, border-color 0.25s ease',
            }}
          >
            <m.span
              key={`chip-${on ? 1 : 0}`}
              initial={on && !reduce ? { scale: 0.75 } : false}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 26 }}
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full"
              style={{
                background: on ? 'var(--accent)' : 'var(--surface-2)',
                color: on ? '#ffffff' : 'var(--text-subtle)',
                transition: 'background 0.25s ease, color 0.25s ease',
              }}
            >
              <Icon name={t.icon} size={16} />
            </m.span>
            <span className="flex min-w-0 flex-col gap-px">
              <span className="truncate text-[13px] font-semibold tracking-tight text-text">
                {t.label}
              </span>
              <span
                className="text-[11px] font-semibold"
                style={{
                  color: on ? 'var(--accent)' : 'var(--text-subtle)',
                  transition: 'color 0.25s ease',
                }}
              >
                {unavailable && t.modes ? modesHint(t.modes) : on ? 'On' : 'Off'}
              </span>
            </span>
          </m.button>
        );
      })}
    </div>
  );
}

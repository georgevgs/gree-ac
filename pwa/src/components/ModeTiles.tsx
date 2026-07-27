import { useRef, type KeyboardEvent } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import type { Mode } from '../api/types';
import { MODE_OPTIONS } from '../options';
import { modeColor, modeSoft, modeText } from '../theme';
import { Icon } from './Icon';

interface Props {
  /** Highlighted mode — pass null when the unit is off, so no tile lights up. */
  value: Mode | null;
  disabled?: boolean;
  onSelect: (m: Mode) => void;
}

// Stable references so re-renders never replay the selection pop.
const POP = { scale: [0.92, 1] };
const REST = { scale: 1 };

/** The design's mode pills: five equal columns, icon over label. The active
 *  one washes in its own mode color; inactive ones sit on plain surface with
 *  a hairline border and only color their icon on selection. One tab stop:
 *  roving tabindex, arrows move focus and selection. */
export function ModeTiles({ value, disabled, onSelect }: Props) {
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIdx = Math.max(0, MODE_OPTIONS.findIndex((o) => o.key === value));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (i + 1) % MODE_OPTIONS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (i - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = MODE_OPTIONS.length - 1;
    }
    if (next < 0) return;
    e.preventDefault();
    // Focus still moves while unavailable, so the options can be read; only
    // the selection is withheld.
    refs.current[next]?.focus();
    if (disabled) return;
    if (MODE_OPTIONS[next].key !== value) onSelect(MODE_OPTIONS[next].key);
  };

  return (
    <div className="flex gap-[9px]" role="radiogroup" aria-label="Mode">
      {MODE_OPTIONS.map((opt, i) => {
        const active = opt.key === value;
        return (
          <m.button
            key={opt.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === focusIdx ? 0 : -1}
            // aria-disabled, not the native attribute: a disabled button is
            // removed from the tab order entirely, so while the unit was
            // unreachable a screen-reader user could not even hear which modes
            // exist. This keeps them readable and refuses the press instead.
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (disabled) return;
              onSelect(opt.key);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            initial={active && !reduce ? { scale: 0.92 } : false}
            animate={active && !reduce ? POP : REST}
            whileTap={disabled ? undefined : { scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className="flex min-w-0 flex-1 flex-col items-center rounded-[18px] py-[13px]"
            style={{
              opacity: disabled ? 0.4 : 1,
              background: active ? modeSoft(opt.key) : 'var(--surface)',
              border: `1.5px solid ${active ? 'transparent' : 'var(--border)'}`,
              color: active ? modeText(opt.key) : 'var(--text-muted)',
              transition: 'background 0.25s ease, border-color 0.25s ease, color 0.25s ease',
            }}
          >
            <span className="flex" style={{ color: active ? modeColor(opt.key) : 'var(--text-muted)' }}>
              <Icon name={opt.icon} size={22} />
            </span>
            <span className="mt-1.5 text-[12px] font-semibold">{opt.label}</span>
          </m.button>
        );
      })}
    </div>
  );
}

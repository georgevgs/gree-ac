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

/** The design's mode pills: five equal columns, icon over label. The active
 *  one washes in its own mode color; inactive ones sit on plain surface with
 *  a hairline border and only color their icon on selection. */
export function ModeTiles({ value, disabled, onSelect }: Props) {
  const reduce = useReducedMotion();
  return (
    <div className="flex gap-[9px]" role="radiogroup" aria-label="Mode">
      {MODE_OPTIONS.map((opt) => {
        const active = opt.key === value;
        return (
          <m.button
            key={`${opt.key}-${active ? 1 : 0}`}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(opt.key)}
            initial={active && !reduce ? { scale: 0.92 } : false}
            animate={{ scale: 1 }}
            whileTap={disabled ? undefined : { scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className="flex min-w-0 flex-1 flex-col items-center rounded-[18px] py-[13px] disabled:opacity-40"
            style={{
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

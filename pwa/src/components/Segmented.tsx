import { useRef, type KeyboardEvent } from 'react';

interface Item<T extends string> {
  key: T;
  label: string;
}

interface Props<T extends string> {
  items: Item<T>[];
  value: T | null;
  disabled?: boolean;
  /** Accessible name for the group, e.g. "Temperature unit". */
  label: string;
  onChange: (v: T) => void;
}

/** The design's segmented control: a sunken pill; the selected segment floats
 *  on a raised surface chip. Used for °C/°F, appearance, quiet levels.
 *  Each segment's real button extends invisibly past the pill to a 44px-tall
 *  hit area; a roving tabindex plus arrow keys make it one tab stop. */
export function Segmented<T extends string>({ items, value, disabled, label, onChange }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIdx = Math.max(0, items.findIndex((it) => it.key === value));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (i + 1) % items.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (i - 1 + items.length) % items.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = items.length - 1;
    }
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    if (items[next].key !== value) onChange(items[next].key);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full p-[3px]"
      style={{ background: 'var(--surface-sunken)', boxShadow: 'var(--shadow-inset)' }}
    >
      {items.map((it, i) => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === focusIdx ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(it.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className="-my-2 rounded-full py-2 disabled:opacity-40"
          >
            <span
              className="block rounded-full px-4 py-[7px] text-[14px] font-semibold"
              style={{
                background: active ? 'var(--surface)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: active ? 'var(--shadow-sm)' : 'none',
                transition: 'background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease',
              }}
            >
              {it.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

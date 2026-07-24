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
 *  on a raised surface chip. Used for °C/°F, appearance, quiet levels. */
export function Segmented<T extends string>({ items, value, disabled, label, onChange }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full p-[3px]"
      style={{ background: 'var(--surface-sunken)', boxShadow: 'var(--shadow-inset)' }}
    >
      {items.map((it) => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(it.key)}
            className="rounded-full px-4 py-[7px] text-[14px] font-semibold disabled:opacity-40"
            style={{
              background: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-muted)',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
              transition: 'background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

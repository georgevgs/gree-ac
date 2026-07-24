interface Props {
  on: boolean;
  disabled?: boolean;
  /** Accessible name, e.g. "Eco mode". */
  label: string;
  onToggle: (on: boolean) => void;
}

/** The design's 46×28 pill switch with a springy white knob. */
export function Switch({ on, disabled, label, onToggle }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!on)}
      className="relative h-7 w-[46px] shrink-0 rounded-full disabled:opacity-40"
      style={{
        background: on ? 'var(--accent)' : 'var(--track-off)',
        transition: 'background 0.2s ease',
      }}
    >
      <span
        className="absolute top-[3px] h-[22px] w-[22px] rounded-full"
        style={{
          left: on ? 21 : 3,
          background: 'var(--thumb)',
          boxShadow: 'var(--shadow-xs)',
          transition: 'left 0.22s var(--ease-spring)',
        }}
      />
    </button>
  );
}

import { m } from 'framer-motion';
import { Icon } from './Icon';

interface Props {
  power: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}

/** The design's round power button: brand accent + glow while on, quiet
 *  sunken surface while off. */
export function PowerToggle({ power, disabled, onToggle }: Props) {
  return (
    <m.button
      type="button"
      onClick={() => onToggle(!power)}
      disabled={disabled}
      aria-pressed={power}
      aria-label="Power"
      whileTap={disabled ? undefined : { scale: 0.9 }}
      className="flex h-[46px] w-[46px] items-center justify-center rounded-full disabled:opacity-40"
      style={{
        background: power ? 'var(--accent)' : 'var(--surface-2)',
        color: power ? 'var(--on-accent)' : 'var(--text-muted)',
        boxShadow: power ? 'var(--glow-accent)' : 'none',
        transition: 'background 0.3s ease, color 0.3s ease, box-shadow 0.4s ease',
      }}
    >
      <Icon name="power" size={22} strokeWidth={2.2} />
    </m.button>
  );
}

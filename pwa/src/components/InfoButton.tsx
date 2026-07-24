import { Icon } from './Icon';

interface Props {
  open: boolean;
  onToggle: () => void;
  /** Section name, used for the accessible label (e.g. "Quiet"). */
  label: string;
}

/** The outlined ⓘ that shows or hides a HelpPanel — muted until opened, then
 *  accent-tinted. It stays tappable even when the AC is off, since you
 *  shouldn't have to turn the unit on just to read what a button does.
 *  The button is a 44px invisible hit area; the 26px circle is the visual. */
export function InfoButton({ open, onToggle, label }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? `Hide help for ${label}` : `What does ${label} do?`}
      className="-mx-[9px] -my-[13px] flex h-11 w-11 items-center justify-center rounded-full"
    >
      <span
        className="flex h-[26px] w-[26px] items-center justify-center rounded-full transition-colors"
        style={{
          background: open ? 'var(--accent-soft)' : 'transparent',
          color: open ? 'var(--accent-hover)' : 'var(--text-muted)',
        }}
      >
        <Icon name="info" size={17} strokeWidth={1.8} />
      </span>
    </button>
  );
}

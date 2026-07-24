import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface Props {
  icon: IconName;
  label: string;
  /** Right side: a value string, a Switch, a Segmented — anything. */
  right?: ReactNode;
  /** Rendered just after the label — e.g. an InfoButton. */
  info?: ReactNode;
  /** Draw the hairline under this row (all but the last in a card). */
  divider?: boolean;
}

/** One list row inside a rounded card — icon, label, right-side content.
 *  The design's Timer/Eco/Settings rows. */
export function Row({ icon, label, right, info, divider }: Props) {
  return (
    <div
      className="flex w-full items-center gap-3 px-[18px] py-[15px]"
      style={divider ? { borderBottom: '1px solid var(--border)' } : undefined}
    >
      <span className="flex text-t2">
        <Icon name={icon} size={20} />
      </span>
      <span className="flex flex-1 items-center gap-2 text-left text-[15px] font-semibold text-text">
        {label}
        {info}
      </span>
      {typeof right === 'string' ? (
        <span className="text-[14px] text-t2">{right}</span>
      ) : (
        right
      )}
    </div>
  );
}

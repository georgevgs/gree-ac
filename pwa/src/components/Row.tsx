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
 *  The design's Timer/Eco/Settings rows.
 *
 *  The row wraps rather than squeezing. A segmented control has an intrinsic
 *  width it cannot go below, and the cards clip their overflow, so on a 320pt
 *  phone the old single-line row silently cut the last option off the right
 *  edge: "Dark" and "Quiet 3" existed in the DOM but could not be seen or
 *  tapped. The label keeps its min-content width so the right slot is what
 *  drops to its own line when the two no longer fit. */
export function Row({ icon, label, right, info, divider }: Props) {
  return (
    <div
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-3 px-[18px] py-[15px]"
      style={divider ? { borderBottom: '1px solid var(--border)' } : undefined}
    >
      <span className="flex shrink-0 text-t2">
        <Icon name={icon} size={20} />
      </span>
      <span className="flex flex-1 items-center gap-2 text-left text-[15px] font-semibold text-text">
        {label}
        {info}
      </span>
      {typeof right === 'string' ? (
        <span className="ml-auto shrink-0 text-[14px] text-t2">{right}</span>
      ) : (
        <span className="ml-auto shrink-0">{right}</span>
      )}
    </div>
  );
}

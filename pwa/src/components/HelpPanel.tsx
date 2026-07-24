import { m } from 'framer-motion';
import type { HelpEntry } from '../help';

/** Shows one help entry: a summary line, an optional list of what each value
 *  means, and an optional caveat. Just presentation; the parent decides when
 *  it's open. */
export function HelpPanel({ entry }: { entry: HelpEntry }) {
  return (
    <m.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="overflow-hidden"
    >
      <div className="mt-2.5 space-y-3 rounded-2xl bg-fill p-4 text-[13.5px] leading-relaxed text-t2">
        <p>{entry.summary}</p>
        {entry.items && (
          <ul className="space-y-1.5">
            {entry.items.map((it) => (
              <li key={it.label}>
                <span className="font-semibold text-text">{it.label}</span>
                {': '}
                <span className="text-t2">{it.desc}</span>
              </li>
            ))}
          </ul>
        )}
        {entry.note && <p className="text-[12px] text-t3">{entry.note}</p>}
      </div>
    </m.div>
  );
}

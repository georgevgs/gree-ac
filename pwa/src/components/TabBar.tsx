import { useLayoutEffect, useRef, useState } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import { Icon, type IconName } from './Icon';

export type Tab = 'home' | 'settings';

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'settings', label: 'Settings', icon: 'gear' },
];

type PillRect = { x: number; y: number; width: number; height: number };

/** Floating glass tab bar, iOS 26 style: a frosted capsule hovering above the
 *  home indicator, content blurring through as it scrolls beneath. The active
 *  tab sits on a brighter pill that slides between tabs. Fixed to the
 *  viewport, so it stays at the bottom regardless of page length.
 *
 *  The pill is one element springing to the measured rect of the active
 *  button — not a framer `layoutId` pair — so the whole app fits LazyMotion's
 *  smaller domAnimation feature set (layout projection would need domMax). */
export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const reduce = useReducedMotion();
  const navRef = useRef<HTMLElement>(null);
  const buttonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<PillRect | null>(null);

  // Glue the pill to the active button. Re-measures when the nav's size
  // changes (font swap-in, orientation change), not just on tab switches.
  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current;
      const button = buttonRefs.current[tab];
      if (!nav || !button) return;
      const n = nav.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      setPill({ x: b.left - n.left, y: b.top - n.top, width: b.width, height: b.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [tab]);

  return (
    <nav
      ref={navRef}
      aria-label="Sections"
      className="fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full p-1.5"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom) + 14px)',
        background: 'var(--glass)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
        backdropFilter: 'blur(20px) saturate(1.8)',
        border: '1px solid var(--glass-edge)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {pill && (
        <m.span
          aria-hidden
          className="absolute left-0 top-0 rounded-full"
          initial={false}
          animate={{ x: pill.x, y: pill.y, width: pill.width, height: pill.height }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 38 }}
          style={{ background: 'var(--glass-active)', boxShadow: 'var(--shadow-xs)' }}
        />
      )}
      {TABS.map((t) => {
        const active = t.key === tab;
        return (
          <m.button
            key={t.key}
            ref={(el) => {
              buttonRefs.current[t.key] = el;
            }}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(t.key)}
            whileTap={{ scale: 0.95 }}
            className="relative flex items-center gap-2 rounded-full px-5 py-2.5"
            style={{
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              transition: 'color 0.2s ease',
            }}
          >
            <span className="relative flex items-center gap-2">
              <Icon name={t.icon} size={21} strokeWidth={active ? 2.1 : 1.9} />
              <span className="text-[13px] font-semibold">{t.label}</span>
            </span>
          </m.button>
        );
      })}
    </nav>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import { Icon, type IconName } from './Icon';

export type Tab = 'home' | 'settings';

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'settings', label: 'Settings', icon: 'gear' },
];

type PillRect = { x: number; y: number; width: number; height: number };

// Scroll-direction detection: ignore jitter smaller than this many pixels.
const SCROLL_JITTER = 4;
// Within this distance from the top the bar is always shown.
const TOP_ZONE = 80;
// Offscreen travel that clears the bar plus its bottom offset and safe inset.
const HIDE_Y = 128;

/** Floating glass tab bar, iOS 26 style: a frosted capsule hovering above the
 *  home indicator. The active tab sits on a brighter pill that slides between
 *  tabs. Fixed to the viewport, and it auto-hides: scrolling down slides it
 *  offscreen so nothing covers the content being read; scrolling up (or
 *  landing near the top) brings it back.
 *
 *  The pill is one element springing to the measured rect of the active
 *  button — not a framer `layoutId` pair — so the whole app fits LazyMotion's
 *  smaller domAnimation feature set (layout projection would need domMax). */
export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const reduce = useReducedMotion();
  const navRef = useRef<HTMLElement>(null);
  const buttonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<PillRect | null>(null);
  const [hidden, setHidden] = useState(false);

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

  // Hide on scroll down, show on scroll up or near the top. rAF-throttled;
  // passive so it never blocks the scroll itself.
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        const delta = y - lastY;
        lastY = y;
        if (Math.abs(delta) <= SCROLL_JITTER) return;
        if (y < TOP_ZONE) {
          setHidden(false);
        } else if (delta > 0) {
          setHidden(true);
        } else {
          setHidden(false);
        }
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <m.nav
      ref={navRef}
      aria-label="Sections"
      className="fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full p-1.5"
      initial={false}
      animate={{ y: hidden ? HIDE_Y : 0 }}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 40 }}
      style={{
        bottom: 'calc(env(safe-area-inset-bottom) + 14px)',
        // framer drives y; keep the horizontal centering out of its transform.
        x: '-50%',
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
    </m.nav>
  );
}

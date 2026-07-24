import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import type { Mode } from './api/types';
import { useACState } from './hooks/useACState';
import { useTheme } from './hooks/useTheme';
import { modeAccentVars } from './theme';
import { TabBar, type Tab } from './components/TabBar';
import { HomeScreen } from './screens/HomeScreen';
import { SettingsScreen } from './screens/SettingsScreen';

export default function App() {
  const ac = useACState();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<Tab>('home');
  const reduce = useReducedMotion();

  // Start each tab at its top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  // While the unit runs, the accent family follows the active mode (blue for
  // cool, orange for heat…); off/offline falls back to the brand green.
  let accentMode: Mode | null = null;
  if (ac.state && ac.state.power && ac.state.online) {
    accentMode = ac.state.mode;
  }

  let screen: ReactNode;
  if (tab === 'home') {
    screen = <HomeScreen state={ac.state} error={ac.error} command={ac.command} />;
  } else {
    screen = (
      <SettingsScreen state={ac.state} command={ac.command} theme={theme} setTheme={setTheme} />
    );
  }

  return (
    // LazyMotion: every animated element in the app is an `m.*` component, so
    // only the domAnimation feature set ships — nothing here may use layout
    // projection (layoutId) or framer drag, which need the far bigger domMax
    // (the TabBar pill springs to a measured rect for exactly this reason).
    // strict makes any stray full `motion.*` component throw instead of
    // silently dragging the whole animation bundle back in.
    <LazyMotion features={domAnimation} strict>
      {/* min-height 100lvh (large viewport): short tabs like Settings still span
          the full screen, so the page bottom — and the floating bar's backdrop —
          sit in the same place on every tab. Falls back to min-h-full where lvh
          is unsupported. */}
      <div
        className="min-h-full"
        style={{ ...modeAccentVars(accentMode), minHeight: '100lvh' }}
      >
        <div
          className="mx-auto max-w-md px-5 pt-[max(1.25rem,env(safe-area-inset-top))]"
          style={{ paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={tab}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            >
              {screen}
            </m.div>
          </AnimatePresence>
        </div>
        <TabBar tab={tab} onChange={setTab} />
      </div>
    </LazyMotion>
  );
}

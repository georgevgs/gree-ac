import { useState, type ReactNode } from 'react';
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m, useReducedMotion } from 'framer-motion';
import type { AcError } from './api/acClient';
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

  // While the unit runs, the accent family follows the active mode (blue for
  // cool, orange for heat…); off/offline falls back to the brand green.
  let accentMode: Mode | null = null;
  if (ac.state.power && ac.state.online) {
    accentMode = ac.state.mode;
  }

  let screen: ReactNode;
  if (tab === 'home') {
    screen = <HomeScreen phase={ac.phase} state={ac.state} error={ac.error} command={ac.command} />;
  } else {
    screen = (
      <SettingsScreen phase={ac.phase} state={ac.state} command={ac.command} theme={theme} setTheme={setTheme} />
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
      <MotionConfig reducedMotion="user">
        {/* min-height 100lvh (large viewport): short tabs like Settings still span
            the full screen, so the page bottom — and the floating bar's backdrop —
            sit in the same place on every tab. Falls back to min-h-full where lvh
            is unsupported. */}
        <div
          className="min-h-full"
          style={{ ...modeAccentVars(accentMode), minHeight: '100lvh' }}
        >
          {/* <main>, so screen-reader landmark navigation can skip straight to
              the controls instead of walking the whole page. */}
          <main
            className="mx-auto max-w-md px-5 pt-[max(1.25rem,env(safe-area-inset-top))]"
            style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}
          >
            {/* Scroll resets only after the old screen has animated out — doing
                it on tab change yanked the exiting screen while still visible. */}
            <AnimatePresence mode="wait" initial={false} onExitComplete={() => window.scrollTo(0, 0)}>
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
          </main>
          <TabBar tab={tab} onChange={setTab} />
          <CommandErrorBanner error={ac.commandError} onDismiss={ac.dismissCommandError} />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}

/** Slim capsule under the status bar naming the write that didn't land — the
 *  toggles are non-optimistic, so without it a failed tap is just silence.
 *  Auto-clears (useACState) and taps away. */
function CommandErrorBanner({ error, onDismiss }: { error: AcError | null; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  return (
    // The live region is this wrapper, which is always mounted. Putting it on
    // the banner meant the region came into existence already containing its
    // text, which screen readers usually do not announce — a failed write was
    // silent to anyone not looking at the screen. It also let role="status"
    // override the button's own role, so it never read as dismissible.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-5"
      style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
    >
      <AnimatePresence>
        {error && (
          <m.button
            type="button"
            onClick={onDismiss}
            initial={reduce ? false : { opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="pointer-events-auto max-w-full truncate rounded-full px-4 py-2 text-[13px] font-semibold"
            style={{
              background: 'color-mix(in oklab, var(--danger-500) 10%, var(--surface))',
              border: '1px solid color-mix(in oklab, var(--danger-500) 30%, transparent)',
              color: 'var(--danger-500)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            {commandErrorText(error)}
          </m.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function commandErrorText(error: AcError): string {
  if (error.kind === 'network' || error.kind === 'timeout') return 'Not sent — can’t reach the bridge';
  if (error.kind === 'ac-offline') return 'Not sent — unit offline';
  if (error.kind === 'auth') return 'Not sent — add the bridge token in Settings';
  if (error.kind === 'rejected') return 'Not sent — the unit refused that setting';
  // 'server': a 500, a bad gateway, anything unclassified. The raw text is a
  // wire detail ("Request failed: 502"), which tells the person holding the
  // phone nothing they can act on; it stays in the console for whoever debugs.
  console.error('bridge error', error);
  return 'Not sent — the bridge had a problem';
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acClient, subscribeState } from '../api/acClient';
import type { ACState } from '../api/types';
import { readDemoState } from '../demo';

// The bridge pushes every change over SSE, so polling is only a safety net:
// slow while the stream is healthy, brisk while it isn't.
const POLL_MS = 2000;
const POLL_MS_STREAMING = 15000;

// ACState is flat (primitives only), so field equality is full equality.
// Returning the previous reference lets React bail out of re-rendering the
// whole tree on the frequent "nothing changed" poll responses.
function keepIfSame(prev: ACState | null, next: ACState): ACState {
  if (prev === null) return next;
  const keys = Object.keys(next) as (keyof ACState)[];
  return keys.every((k) => prev[k] === next[k]) ? prev : next;
}

export function useACState() {
  // Dev-only ?demo= preview: freeze a canned state, no polling or writes.
  const demo = useMemo(() => readDemoState(), []);
  const [state, setState] = useState<ACState | null>(demo);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  // A write's response must not be clobbered by a poll that was already in
  // flight when it landed — a slow read would otherwise resurrect the old
  // setpoint seconds later. Drop any read issued before the newest write.
  const lastWriteAt = useRef(0);

  const refresh = useCallback(async () => {
    if (demo) return;
    const startedAt = Date.now();
    try {
      const s = await acClient.getState();
      if (startedAt >= lastWriteAt.current) setState((prev) => keepIfSame(prev, s));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [demo]);

  // Live push. The stream also carries the current state on connect, so a
  // reconnect re-syncs on its own. Frames are device truth and always win —
  // including over a write's optimistic echo, which is the point.
  useEffect(() => {
    if (demo) return;

    return subscribeState(
      (s) => {
        setStreaming(true);
        setState((prev) => keepIfSame(prev, s));
        setError(null);
      },
      () => setStreaming(false),
    );
  }, [demo]);

  // Poll while the tab is visible; pause when hidden; refresh immediately on
  // focus/return. Standard data-freshness behaviour (as SWR / React Query do),
  // and the fallback whenever the push stream is down.
  useEffect(() => {
    if (demo) return;

    const period = streaming ? POLL_MS_STREAMING : POLL_MS;
    let interval: number | null = null;
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      if (interval === null) interval = window.setInterval(() => void refresh(), period);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => void refresh();

    void refresh();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, streaming, demo]);

  // Run a command, apply the fresh state it returns; re-sync on failure. The
  // UI is optimistic (the setpoint updates the instant the response lands, and
  // the stepper holds its value before that), so an in-flight write needs no
  // "busy" state — dimming the controls for the ~100 ms it takes just reads as
  // a flash. Availability (offline / powered-off) is what greys the controls,
  // and that is derived from `state`, not from the write.
  const command = useCallback(
    async (fn: () => Promise<ACState>) => {
      try {
        const s = await fn();
        lastWriteAt.current = Date.now();
        setState((prev) => keepIfSame(prev, s));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        void refresh();
      }
    },
    [refresh],
  );

  // `refresh` stays internal: it backs the poll loop and write-failure
  // re-sync; no consumer triggers a manual refresh.
  return { state, error, command };
}

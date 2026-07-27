import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acClient, onTokenChange, subscribeState, toAcError } from '../api/acClient';
import type { AcError } from '../api/acClient';
import { EMPTY_STATE, type ACState } from '../api/types';
import { readDemo } from '../demo';

// The bridge pushes every change over SSE, so polling is only a safety net:
// slow while the stream is healthy, brisk while it isn't.
const POLL_MS = 2000;
const POLL_MS_STREAMING = 15000;

// How long a failed write stays on screen before it clears itself.
const COMMAND_ERROR_MS = 4000;

// ACState is flat (primitives only), so field equality is full equality.
// Returning the previous reference lets React bail out of re-rendering the
// whole tree on the frequent "nothing changed" poll responses.
function keepIfSame(prev: ACState | null, next: ACState): ACState {
  if (prev === null) return next;
  const keys = Object.keys(next) as (keyof ACState)[];
  return keys.every((k) => prev[k] === next[k]) ? prev : next;
}

export function useACState() {
  // Dev-only ?demo= preview: freeze a canned situation, no polling or writes.
  // A demo can pin a read failure or an unlanded write too, so the states that
  // most need visual checking are the ones a screenshot can actually reach.
  const demo = useMemo(() => readDemo(), []);
  const [state, setState] = useState<ACState | null>(demo?.state ?? null);
  const [error, setError] = useState<AcError | null>(demo?.error ?? null);
  // A failed write lives apart from `error`: the read path clears `error` on
  // every good poll, which would wipe the failure off screen before anyone
  // read it. This one only leaves via its own timer or an explicit dismiss.
  const [commandError, setCommandError] = useState<AcError | null>(demo?.commandError ?? null);
  const [streaming, setStreaming] = useState(false);

  // A write's response must not be clobbered by a poll that was already in
  // flight when it landed — a slow read would otherwise resurrect the old
  // setpoint seconds later. Drop any read issued before the newest write.
  const lastWriteAt = useRef(0);

  const commandErrorTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (commandErrorTimer.current !== null) window.clearTimeout(commandErrorTimer.current);
    };
  }, []);

  const dismissCommandError = useCallback(() => {
    if (commandErrorTimer.current !== null) {
      window.clearTimeout(commandErrorTimer.current);
      commandErrorTimer.current = null;
    }
    setCommandError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (demo) return;
    const startedAt = Date.now();
    try {
      const s = await acClient.getState();
      if (startedAt >= lastWriteAt.current) setState((prev) => keepIfSame(prev, s));
      setError(null);
    } catch (e) {
      setError(toAcError(e));
    }
  }, [demo]);

  // Live push. The stream also carries the current state on connect, so a
  // reconnect re-syncs on its own. Frames are device truth and always win —
  // including over a write's optimistic echo, which is the point.
  //
  // iOS kills the socket when the app suspends and WebKit doesn't reliably
  // fire onerror for it, so `streaming` would stay true over a dead stream and
  // the fallback poll would idle at its slow period. Re-subscribing whenever
  // the tab returns to the foreground makes the resume self-syncing.
  useEffect(() => {
    if (demo) return;

    const subscribe = () =>
      subscribeState(
        (s) => {
          setStreaming(true);
          setState((prev) => keepIfSame(prev, s));
          setError(null);
        },
        () => setStreaming(false),
      );

    let unsubscribe = subscribe();
    const reconnect = () => {
      unsubscribe();
      unsubscribe = subscribe();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      reconnect();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // The token is baked into the stream's URL, so a new one only takes effect
    // on a fresh connection.
    const stopWatchingToken = onTokenChange(reconnect);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopWatchingToken();
      unsubscribe();
    };
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
    // No `focus` listener beside this one: in a standalone PWA both fire on the
    // same foreground, which just doubled every resume into two reads of the
    // same state. The read that stays is the one that matters — iOS can leave a
    // dead stream looking alive, so a resume must not trust `streaming`.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    // This effect re-runs whenever `streaming` flips. On the flip to true the
    // stream has just delivered a full snapshot, so refreshing here would ask
    // for the state we were handed a moment ago; on the flip to false the
    // stream is gone and an immediate read is the whole point.
    if (!streaming) void refresh();
    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
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
      if (demo) return;
      try {
        const s = await fn();
        lastWriteAt.current = Date.now();
        setState((prev) => keepIfSame(prev, s));
        setError(null);
      } catch (e) {
        if (commandErrorTimer.current !== null) window.clearTimeout(commandErrorTimer.current);
        setCommandError(toAcError(e));
        commandErrorTimer.current = window.setTimeout(() => {
          setCommandError(null);
          commandErrorTimer.current = null;
        }, COMMAND_ERROR_MS);
        void refresh();
      }
    },
    [demo, refresh],
  );

  // `refresh` stays internal: it backs the poll loop and write-failure
  // re-sync; no consumer triggers a manual refresh.
  //
  // `phase` is what "we have not heard from the bridge yet" looks like, and
  // `state` is never null, so screens read `state.mode` instead of threading
  // `state?.mode ?? null` through every prop. Optional chaining on server data
  // belongs at the boundary, not in the components.
  return {
    phase: state === null ? ('connecting' as const) : ('live' as const),
    state: state ?? EMPTY_STATE,
    error,
    command,
    commandError,
    dismissCommandError,
  };
}

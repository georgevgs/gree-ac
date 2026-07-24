import { useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import type { FanSpeed } from '../api/types';
import { FAN_OPTIONS } from '../options';
import type { HelpEntry } from '../help';
import { Icon } from './Icon';
import { InfoButton } from './InfoButton';
import { HelpPanel } from './HelpPanel';

interface Props {
  value: FanSpeed | null;
  disabled?: boolean;
  onChange: (f: FanSpeed) => void;
  /** Help entry toggled by an ⓘ next to the card's label. */
  help?: HelpEntry;
}

const KNOB = 26;

/** The design's fan card: icon + label row, then a sunken track with an
 *  accent fill and a white knob. Six discrete stops (Auto … High); drag or
 *  tap snaps to the nearest, committed on release. */
export function FanSlider({ value, disabled, onChange, help }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const steps = FAN_OPTIONS.length;
  // Unknown speed (still connecting): park the knob at 0 but say "—" rather
  // than claiming "Auto".
  const restIdx = Math.max(0, FAN_OPTIONS.findIndex((o) => o.key === value));
  const idx = dragIdx ?? restIdx;
  const frac = idx / (steps - 1);
  let label = '—';
  if (dragIdx != null) {
    label = FAN_OPTIONS[dragIdx].label;
  } else if (value != null) {
    label = FAN_OPTIONS[restIdx].label;
  }

  const idxFromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left - KNOB / 2) / (rect.width - KNOB)));
    return Math.round(f * (steps - 1));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragIdx(idxFromPointer(e));
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setDragIdx(idxFromPointer(e));
  };
  const onUp = () => {
    if (dragIdx == null) return;
    const next = FAN_OPTIONS[dragIdx].key;
    setDragIdx(null);
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let delta = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      delta = 1;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      delta = -1;
    }
    if (delta === 0) return;
    e.preventDefault();
    const next = FAN_OPTIONS[Math.min(steps - 1, Math.max(0, restIdx + delta))].key;
    if (next !== value) onChange(next);
  };

  return (
    <section className="card px-[18px] py-[18px]" style={{ opacity: disabled ? 0.5 : 1, transition: 'opacity 0.3s ease' }}>
      <div className="mb-3.5 flex items-center justify-between text-[14px]">
        <span className="flex items-center gap-2 font-semibold text-text">
          <span className="flex text-t2">
            <Icon name="fan" size={18} />
          </span>
          Fan speed
          {help && <InfoButton open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} label="Fan speed" />}
        </span>
        <span className="font-mono text-[13px] text-t2">{label}</span>
      </div>
      {help && (
        <AnimatePresence initial={false}>
          {helpOpen && (
            <div className="mb-3.5 -mt-1">
              <HelpPanel entry={help} />
            </div>
          )}
        </AnimatePresence>
      )}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Fan speed"
        aria-valuemin={0}
        aria-valuemax={steps - 1}
        aria-valuenow={restIdx}
        aria-valuetext={label}
        onKeyDown={onKeyDown}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative h-3 touch-none select-none rounded-full"
        style={{ background: 'var(--surface-sunken)', boxShadow: 'var(--shadow-inset)', cursor: disabled ? 'default' : 'pointer' }}
      >
        <div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{
            width: `calc(${frac} * (100% - ${KNOB}px) + ${KNOB}px)`,
            background: 'var(--accent)',
            transition: dragIdx == null ? 'width 0.25s var(--ease-out)' : 'none',
          }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `calc(${frac} * (100% - ${KNOB}px))`,
            width: KNOB,
            height: KNOB,
            background: 'var(--thumb)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-sm)',
            transition: dragIdx == null ? 'left 0.25s var(--ease-out)' : 'none',
          }}
        />
      </div>
    </section>
  );
}

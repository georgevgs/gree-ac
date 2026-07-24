import { useReducedMotion } from 'framer-motion';
import type { KeyboardEvent } from 'react';
import { AIRFLOW_VERT_ZONES, AIRFLOW_HOR_ZONES, type AirflowZone } from '../options';

/* The Airflow card as two little room diagrams instead of dropdowns: a side
 * view (air tilting up/down) and a top-down view (air turning left/right).
 * Five beams fan out from the unit; tapping one sends the air that way. The
 * chips pick what a beam tap means (Aim vs Sweep) plus the axis-wide Off and
 * Full sweep. Sweeping states show a louvre beam rocking between its bounds. */

// Beam radii in viewBox units: visible beam span, the dotted range arc, and
// the wedge-shaped tap targets. R_HIT runs past the viewBox (the svg is
// overflow-visible) so taps overshooting a beam tip still land in its zone.
const R_IN = 13;
const R_OUT = 62;
const R_ARC = 69;
const R_HIT = 86;

interface Point {
  x: number;
  y: number;
}

interface Geo {
  /** Louvre pivot — every beam radiates from here. */
  origin: Point;
  /** Beam directions in degrees (0 = right, 90 = down), one per zone. */
  angles: number[];
  /** Wall/floor hairlines sketching the room around the unit. */
  room: string;
  /** The indoor unit, drawn as a rounded block. */
  unit: { x: number; y: number; w: number; h: number };
}

// Side view: unit high on the left wall; beams tilt from a flat throw (Top)
// down the wall (Bottom).
const VERT_GEO: Geo = {
  origin: { x: 46, y: 29 },
  angles: [16, 31, 46, 61, 76],
  room: 'M8 6 V98 H132',
  unit: { x: 9, y: 12, w: 40, h: 17 },
};

// Top-down view: unit against the far wall seen from above; beams turn from
// Left to Right.
const HOR_GEO: Geo = {
  origin: { x: 70, y: 27 },
  angles: [142, 116, 90, 64, 38],
  room: 'M8 8 H132',
  unit: { x: 42, y: 9, w: 56, h: 16 },
};

const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (o: Point, deg: number, r: number): [number, number] => [
  +(o.x + r * Math.cos(rad(deg))).toFixed(1),
  +(o.y + r * Math.sin(rad(deg))).toFixed(1),
];

function arcPath(o: Point, r: number, from: number, to: number): string {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const [x1, y1] = pt(o, lo, r);
  const [x2, y2] = pt(o, hi, r);
  return `M${x1} ${y1} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function wedgePath(o: Point, from: number, to: number): string {
  const [x1, y1] = pt(o, from, R_HIT);
  const [x2, y2] = pt(o, to, R_HIT);
  return `M${o.x} ${o.y} L${x1} ${y1} A${R_HIT} ${R_HIT} 0 0 1 ${x2} ${y2} Z`;
}

type Kind = 'off' | 'full' | 'aim' | 'sweep' | null;

function captionFor(kind: Kind, zones: AirflowZone[], zone: number): string {
  if (kind === 'off') return 'Off';
  if (kind === 'full') return 'Full sweep';
  if (kind === 'aim') return `Aim · ${zones[zone].label}`;
  if (kind === 'sweep') return `Sweep · ${zones[zone].label}`;
  return '—';
}

function parseSwing(value: string | null, zones: AirflowZone[]): { kind: Kind; zone: number } {
  if (value === 'default') return { kind: 'off', zone: -1 };
  if (value === 'full') return { kind: 'full', zone: -1 };
  const aim = zones.findIndex((z) => z.fixed === value);
  if (aim >= 0) return { kind: 'aim', zone: aim };
  const sweep = zones.findIndex((z) => z.swing === value);
  if (sweep >= 0) return { kind: 'sweep', zone: sweep };
  return { kind: null, zone: -1 };
}

interface Props {
  vert: string | null;
  hor: string | null;
  disabled?: boolean;
  onSet: (axis: 'vert' | 'hor', value: string) => void;
}

export function AirflowPicker({ vert, hor, disabled, onSet }: Props) {
  return (
    <div
      className="card overflow-hidden"
      style={{ opacity: disabled ? 0.5 : 1, transition: 'opacity 0.3s ease' }}
    >
      <AxisSection
        title="Up / down"
        ariaLabel="Vertical airflow"
        value={vert}
        zones={AIRFLOW_VERT_ZONES}
        geo={VERT_GEO}
        divider
        disabled={disabled}
        onSet={(v) => onSet('vert', v)}
      />
      <AxisSection
        title="Left / right"
        ariaLabel="Horizontal airflow"
        value={hor}
        zones={AIRFLOW_HOR_ZONES}
        geo={HOR_GEO}
        disabled={disabled}
        onSet={(v) => onSet('hor', v)}
      />
    </div>
  );
}

function AxisSection({
  title,
  ariaLabel,
  value,
  zones,
  geo,
  divider,
  disabled,
  onSet,
}: {
  title: string;
  ariaLabel: string;
  value: string | null;
  zones: AirflowZone[];
  geo: Geo;
  divider?: boolean;
  disabled?: boolean;
  onSet: (value: string) => void;
}) {
  const reduce = useReducedMotion();
  const { kind, zone } = parseSwing(value, zones);
  const { origin, angles, room, unit } = geo;
  const canSweep = zones.some((z) => z.swing);
  const halfStep = Math.abs(angles[1] - angles[0]) / 2;
  // The fan's outermost hit wedges stretch half a step past the beams, so a
  // tap just outside the fan still picks the nearest zone.
  const loEdge = Math.min(...angles);
  const hiEdge = Math.max(...angles);

  const caption = captionFor(kind, zones, zone);

  // A beam tap keeps the current Aim/Sweep mode; anything else aims.
  const pick = (i: number) => {
    const z = zones[i];
    onSet(kind === 'sweep' && z.swing ? z.swing : z.fixed);
  };

  // Bounds the louvre rocks between: the zone's beam ± its half-width, or the
  // whole fan for a full sweep.
  let bounds: [number, number] | null = null;
  if (kind === 'full') {
    bounds = [Math.min(...angles), Math.max(...angles)];
  } else if (kind === 'sweep') {
    bounds = [angles[zone] - halfStep, angles[zone] + halfStep];
  }
  let restAngle = 0;
  if (kind === 'sweep') {
    restAngle = angles[zone];
  } else if (bounds) {
    restAngle = (bounds[0] + bounds[1]) / 2;
  }

  return (
    <div
      className="flex items-center gap-4 px-[18px] py-4"
      style={divider ? { borderBottom: '1px solid var(--border)' } : undefined}
    >
      <svg viewBox="0 0 140 104" className="w-[128px] shrink-0 overflow-visible" role="group" aria-label={ariaLabel}>
        <path
          d={room}
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.55"
        />
        <rect
          x={unit.x}
          y={unit.y}
          width={unit.w}
          height={unit.h}
          rx="6"
          fill="var(--surface-sunken)"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
        />

        {angles.map((a, i) => {
          const [x1, y1] = pt(origin, a, R_IN);
          const [x2, y2] = pt(origin, a, R_OUT);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--border-strong)"
              strokeWidth="3"
              strokeLinecap="round"
              opacity={kind === 'aim' && zone === i ? 0 : 0.55}
            />
          );
        })}

        {kind === 'aim' && <AccentBeam o={origin} deg={angles[zone]} />}

        {/* Zone arcs are tiny (±half a step), so their dots pack denser and
            stretch a touch past the bounds to still read as an arc. */}
        {bounds && (
          <path
            d={
              kind === 'full'
                ? arcPath(origin, R_ARC, bounds[0], bounds[1])
                : arcPath(origin, R_ARC, bounds[0] - 2.5, bounds[1] + 2.5)
            }
            fill="none"
            stroke="var(--accent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={kind === 'full' ? '0.5 7.5' : '0.5 5'}
            opacity="0.9"
          />
        )}
        {bounds &&
          (reduce ? (
            <AccentBeam o={origin} deg={restAngle} />
          ) : (
            <SweepBeam o={origin} from={bounds[0]} to={bounds[1]} full={kind === 'full'} />
          ))}

        {angles.map((a, i) => (
          <path
            key={i}
            d={wedgePath(
              origin,
              a - (a === loEdge ? halfStep * 1.5 : halfStep),
              a + (a === hiEdge ? halfStep * 1.5 : halfStep),
            )}
            fill="transparent"
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${ariaLabel}: ${zones[i].label}`}
            aria-pressed={zone === i}
            style={{ cursor: disabled ? 'default' : 'pointer' }}
            onClick={() => !disabled && pick(i)}
            onKeyDown={(e: KeyboardEvent<SVGPathElement>) => {
              if (disabled || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              pick(i);
            }}
          />
        ))}
      </svg>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-semibold text-text">{title}</span>
        <span className="mt-0.5 font-mono text-[12px] text-t2">{caption}</span>
        {/* Axis-wide states on the first row, beam-tap modes on the second.
            With three chips the odd one stretches across (as FeatureTiles). */}
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <Chip label="Off" active={kind === 'off'} disabled={disabled} onClick={() => onSet('default')} />
          <Chip label="Full" active={kind === 'full'} disabled={disabled} onClick={() => onSet('full')} />
          <Chip
            label="Aim"
            active={kind === 'aim'}
            disabled={disabled}
            stretch={!canSweep}
            onClick={() => onSet(zones[zone >= 0 ? zone : 2].fixed)}
          />
          {canSweep && (
            <Chip
              label="Sweep"
              active={kind === 'sweep'}
              disabled={disabled}
              onClick={() => onSet(zones[zone >= 0 ? zone : 2].swing!)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** A steady accent beam: soft halo, shaft, and an arrowhead at the tip. */
function AccentBeam({ o, deg }: { o: Point; deg: number }) {
  const [x1, y1] = pt(o, deg, R_IN);
  const [x2, y2] = pt(o, deg, R_OUT);
  const [ax, ay] = pt({ x: x2, y: y2 }, deg + 148, 7);
  const [bx, by] = pt({ x: x2, y: y2 }, deg - 148, 7);
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent)" strokeWidth="11" strokeLinecap="round" opacity="0.18" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent)" strokeWidth="4.5" strokeLinecap="round" />
      <path
        d={`M${ax} ${ay} L${x2} ${y2} L${bx} ${by}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** The louvre in motion: an accent beam rocking between its sweep bounds.
 *  Drawn pointing right and rotated by SMIL, which survives re-renders and
 *  needs no transform-box quirks. */
function SweepBeam({ o, from, to, full }: { o: Point; from: number; to: number; full: boolean }) {
  const x1 = o.x + R_IN;
  const x2 = o.x + R_OUT;
  return (
    <g>
      <line x1={x1} y1={o.y} x2={x2} y2={o.y} stroke="var(--accent)" strokeWidth="11" strokeLinecap="round" opacity="0.18" />
      <line x1={x1} y1={o.y} x2={x2} y2={o.y} stroke="var(--accent)" strokeWidth="4.5" strokeLinecap="round" />
      <path
        d={`M${x2 - 6.2} ${o.y - 3.5} L${x2} ${o.y} L${x2 - 6.2} ${o.y + 3.5}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <animateTransform
        attributeName="transform"
        type="rotate"
        values={`${from} ${o.x} ${o.y}; ${to} ${o.x} ${o.y}; ${from} ${o.x} ${o.y}`}
        keyTimes="0; 0.5; 1"
        calcMode="spline"
        keySplines="0.45 0 0.55 1; 0.45 0 0.55 1"
        dur={full ? '3.6s' : '2.2s'}
        repeatCount="indefinite"
      />
    </g>
  );
}

function Chip({
  label,
  active,
  disabled,
  stretch,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  stretch?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`-my-2.5 rounded-full py-2.5 disabled:opacity-40 ${stretch ? 'col-span-2' : ''}`}
    >
      <span
        className="block rounded-full px-2.5 py-[5px] text-[12px] font-semibold"
        style={{
          background: active ? 'var(--accent-soft)' : 'var(--surface-sunken)',
          color: active ? 'var(--accent)' : 'var(--text-muted)',
          transition: 'background 0.2s ease, color 0.2s ease',
        }}
      >
        {label}
      </span>
    </button>
  );
}

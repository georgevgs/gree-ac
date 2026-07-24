import { modeColor } from '../theme';
import { Icon, type IconName } from './Icon';

interface Props {
  outdoor: number | null;
  indoor: number | null;
}

function Tile({ icon, color, label, value }: { icon: IconName; color: string; label: string; value: string }) {
  return (
    <div className="card flex-1 rounded-[18px] px-4 py-[15px]">
      <div
        className="mb-2 flex h-[34px] w-[34px] items-center justify-center rounded-full"
        style={{ background: 'var(--surface-2)', color }}
      >
        <Icon name={icon} size={19} />
      </div>
      <div className="label-mono" style={{ fontSize: 10, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className="tnum text-[18px] font-bold text-text">{value}</div>
    </div>
  );
}

/** The design's stat tiles. Outside comes from the unit's outdoor sensor;
 *  the second tile is the indoor reading (the design showed humidity, but
 *  this unit has no humidity sensor — inside temp is what's real). */
export function StatTiles({ outdoor, indoor }: Props) {
  return (
    <div className="flex gap-3">
      <Tile icon="cloud" color={modeColor('cool')} label="Outside" value={outdoor != null ? `${outdoor}°C` : '—'} />
      <Tile icon="thermo" color={modeColor('heat')} label="Inside" value={indoor != null ? `${indoor}°C` : '—'} />
    </div>
  );
}

import type { ReactNode } from 'react';

export type IconName =
  | 'power'
  | 'cool'
  | 'heat'
  | 'dry'
  | 'fan'
  | 'auto'
  | 'bulb'
  | 'bolt'
  | 'moon'
  | 'rotor'
  | 'sparkles'
  | 'leaf'
  | 'thermo'
  | 'home'
  | 'gear'
  | 'cloud'
  | 'wifi'
  | 'info'
  | 'plus'
  | 'minus';

// Six-armed snowflake: main spokes with two short branches at 60% radius.
const SNOWFLAKE: ReactNode[] = (() => {
  const c = 12;
  const R = 8.6;
  const branch = 3;
  const lines: ReactNode[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * 60 * Math.PI) / 180;
    lines.push(
      <line
        key={`s${k}`}
        x1={c}
        y1={c}
        x2={(c + R * Math.sin(a)).toFixed(1)}
        y2={(c - R * Math.cos(a)).toFixed(1)}
      />,
    );
    const bx = c + R * 0.6 * Math.sin(a);
    const by = c - R * 0.6 * Math.cos(a);
    for (const s of [-1, 1]) {
      const a2 = a + (s * 42 * Math.PI) / 180;
      lines.push(
        <line
          key={`b${k}${s}`}
          x1={bx.toFixed(1)}
          y1={by.toFixed(1)}
          x2={(bx + branch * Math.sin(a2)).toFixed(1)}
          y2={(by - branch * Math.cos(a2)).toFixed(1)}
        />,
      );
    }
  }
  return lines;
})();

const PATHS: Record<IconName, ReactNode> = {
  power: (
    <>
      <path d="M12 2v9" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </>
  ),
  cool: <>{SNOWFLAKE}</>,
  heat: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
  dry: <path d="M12 2.7l5.7 5.66a8 8 0 1 1-11.4 0z" />,
  fan: (
    <>
      <path d="M12.8 19.6A2 2 0 1 0 14 16H2" />
      <path d="M17.5 8A2.5 2.5 0 1 1 20 10.5H2" />
      <path d="M9.8 4.4A2 2 0 1 1 11 8H2" />
    </>
  ),
  auto: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  bulb: (
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 21.5h4" />
    </>
  ),
  bolt: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  rotor: (
    <>
      <path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z" />
      <path d="M12 12v.01" />
    </>
  ),
  sparkles: (
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M19 3v4" />
      <path d="M21 5h-4" />
    </>
  ),
  leaf: (
    <>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
    </>
  ),
  thermo: <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />,
  home: <path d="M3 11l9-7 9 7M5 9.5V20h14V9.5" />,
  gear: (
    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
  ),
  cloud: <path d="M7 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6-1A3.5 3.5 0 0 0 7 18z" />,
  wifi: <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8 15.5a5.5 5.5 0 0 1 8 0M12 19h.01" />,
  info: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />
      <path d="M12 11v5M12 7.5h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
};

export function Icon({
  name,
  size = 22,
  strokeWidth = 1.9,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

import type { CSSProperties } from 'react';
import type { Mode } from './api/types';

/* Mode colors from the design system's tokens: temperature is literal —
 * blue = cool, orange = heat, violet = dry, cyan-teal = fan, green = auto.
 * While the unit runs, the whole accent family retunes to the active mode
 * (see modeAccentVars); the brand green remains the standby/off accent.
 * Each value is a light-dark() pair so it tracks the active scheme on its own. */

type Pair = { light: string; dark: string };

const MODE_HUE: Record<Mode, { h: number; c: number; l: Pair }> = {
  cool: { h: 230, c: 0.13, l: { light: '0.65', dark: '0.72' } },
  heat: { h: 40, c: 0.15, l: { light: '0.70', dark: '0.74' } },
  dry: { h: 300, c: 0.13, l: { light: '0.72', dark: '0.72' } },
  fan_only: { h: 200, c: 0.1, l: { light: '0.72', dark: '0.72' } },
  auto: { h: 165, c: 0.14, l: { light: '0.70', dark: '0.78' } },
};

/** The mode's full-strength color (dial ring, active icons). */
export function modeColor(mode: Mode): string {
  const { h, c, l } = MODE_HUE[mode];
  return `light-dark(oklch(${l.light} ${c} ${h}), oklch(${l.dark} ${c} ${h}))`;
}

/** Soft wash of the mode color (active pill/chip backgrounds). */
export function modeSoft(mode: Mode): string {
  const { h, c } = MODE_HUE[mode];
  return `light-dark(oklch(0.95 ${Math.min(c, 0.05)} ${h}), oklch(0.3 ${Math.min(c, 0.06)} ${h}))`;
}

/** Text/icon color that reads on top of modeSoft. */
export function modeText(mode: Mode): string {
  const { h, c } = MODE_HUE[mode];
  return `light-dark(oklch(0.45 ${c} ${h}), oklch(0.82 ${Math.min(c, 0.11)} ${h}))`;
}

/** Diffuse glow under the dial/power button while running. */
export function modeGlow(mode: Mode): string {
  const { h, c, l } = MODE_HUE[mode];
  return `0 8px 28px oklch(${l.light} ${c} ${h} / 0.32)`;
}

/** CSS-variable overrides that retune the app's accent family to the running
 *  mode. Spread onto the app root: every accent consumer (power button,
 *  stepper, fan fill, switches, tab bar…) follows without knowing about modes.
 *  Pass null (off/offline/unknown) to keep the brand green. */
export function modeAccentVars(mode: Mode | null): CSSProperties {
  if (!mode) return {};
  const { h, c, l } = MODE_HUE[mode];
  const darker = (v: string) => (Number(v) - 0.08).toFixed(2);
  return {
    '--accent': modeColor(mode),
    '--accent-hover': `light-dark(oklch(${darker(l.light)} ${c} ${h}), oklch(${darker(l.dark)} ${c} ${h}))`,
    '--accent-soft': modeSoft(mode),
    '--on-accent': `light-dark(oklch(1 0 0), oklch(0.15 0.02 ${h}))`,
    '--glow-accent': modeGlow(mode),
  } as CSSProperties;
}

const MODE_STATUS: Record<Mode, string> = {
  cool: 'Cooling',
  heat: 'Heating',
  dry: 'Drying',
  fan_only: 'Fan only',
  auto: 'Auto',
};

/** What the unit is doing right now, e.g. "Cooling". Null `online` means
 *  still connecting — no verdict yet, so claim nothing. */
export function modeStatus(mode: Mode | null, power: boolean, online: boolean | null): string {
  if (online == null) return '—';
  return !online ? 'Offline' : !power ? 'Off' : mode ? MODE_STATUS[mode] : '—';
}

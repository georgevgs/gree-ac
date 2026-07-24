// Human-readable blurbs for each control, shown when you tap the little ⓘ next
// to a section. The wording follows how this unit actually behaves (see the
// README's "Feature notes", which came from poking at the GREE protocol)
// rather than generic brochure copy.

export interface HelpItem {
  /** Matches the on-screen label for the value or toggle it explains. */
  label: string;
  desc: string;
}

export interface HelpEntry {
  /** One line on what this section is for. */
  summary: string;
  /** What each value or toggle does. */
  items?: HelpItem[];
  /** A caveat or reminder, shown smaller at the bottom. */
  note?: string;
}

export const HELP = {
  temp: {
    summary: 'Tap − and + to set your target (16 to 30 °C). The unit heats or cools the room toward this number, and the ring fills as the setpoint rises.',
    items: [
      { label: 'Inside', desc: `the indoor sensor's current reading.` },
      { label: 'Outside', desc: `the outdoor unit's sensor. Read-only, shown for reference.` },
    ],
    note: 'You can switch the display between °C and °F in Settings; it does not change the setting itself.',
  },

  mode: {
    summary: 'What the unit does with the air.',
    items: [
      { label: 'Cool', desc: 'cools the room down to your target temperature.' },
      { label: 'Heat', desc: 'warms the room up to your target temperature.' },
      { label: 'Dry', desc: 'dehumidifies. Runs gently to pull moisture out of muggy air without over-cooling.' },
      { label: 'Fan', desc: 'just moves air around, with no heating or cooling.' },
      { label: 'Auto', desc: 'lets the unit decide whether to heat or cool to hold your target.' },
    ],
  },

  fan: {
    summary: 'How hard the indoor fan blows. Faster reaches the target sooner but is louder.',
    items: [
      { label: 'Auto', desc: 'lets the unit pick the speed for you.' },
      { label: 'Low to High', desc: 'fixed speeds, from quietest (Low) to strongest (High). Low+ and Med+ are the steps in between.' },
    ],
  },

  quiet: {
    summary: 'Caps the fan so it runs more quietly, trading a bit of cooling and heating speed for silence.',
    items: [
      { label: 'Off', desc: 'normal fan behaviour.' },
      { label: '1 / 2 / 3', desc: 'progressively quieter and gentler. 3 is the quietest (and slowest).' },
    ],
    note: `The opposite of Turbo, so you can't use both. It has no effect in Dry or Fan mode.`,
  },

  swing: {
    summary: 'Two little room diagrams: the top one shows the room from the side (air tilting up and down), the bottom one from above (air turning left and right). Tap a beam to send the air that way.',
    items: [
      { label: 'Aim', desc: 'holds the louvre still, blowing steadily along the beam you tapped.' },
      { label: 'Sweep', desc: 'rocks the louvre around the tapped beam, fanning air over that area (up/down only).' },
      { label: 'Full', desc: 'sweeps the louvre across its whole range to spread air around the room.' },
      { label: 'Off', desc: 'the louvre stays put where it is.' },
    ],
  },

  features: {
    summary: 'Extra options. Tap to turn each one on or off.',
    items: [
      { label: 'Light', desc: `turns the unit's display lights on or off. It doesn't change how the AC runs, so it's handy in a dark bedroom.` },
      { label: 'Turbo', desc: 'runs the fan flat out for the fastest cool-down or warm-up. The opposite of Quiet.' },
      { label: 'Sleep', desc: 'slowly drifts the target overnight (a little warmer in Cool, cooler in Heat) for comfort and lower running cost.' },
      { label: 'X-Fan', desc: 'after you switch off in Cool or Dry, keeps the fan running a few minutes to dry the coil and stop mildew and musty smells.' },
      { label: 'Ionizer', desc: `GREE's "Health" cold-plasma generator. Releases ions to help freshen the air and trap dust, and it's this unit's headline air-quality feature.` },
      { label: 'Eco', desc: 'energy-saving mode. Caps how hard the compressor works to cut power use.' },
      { label: '8°C Heat', desc: `frost protection. Holds an empty room near 8 °C so it doesn't freeze while you're away. A Heat-mode function, so it's only available there.` },
    ],
  },
} satisfies Record<string, HelpEntry>;

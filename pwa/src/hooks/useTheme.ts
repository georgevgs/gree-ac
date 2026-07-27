import { useEffect, useState } from 'react';

export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'ac-theme';
// Pre-rename key (the app used to be Umi-branded); migrated on first read.
const LEGACY_KEY = 'umi-theme';
const ICON = { light: '/icon.svg?v=4', dark: '/icon-dark.svg?v=4' };

/** The two chrome background colors, read once from the media-gated
 *  `theme-color` tags in index.html rather than restated here. Keeping a second
 *  copy in TypeScript meant one edit to the palette could leave the iOS status
 *  bar a different color from the page it sits above. Captured before anything
 *  below overwrites `content`. */
let authored: { light: string; dark: string } | null = null;
function backgrounds() {
  if (authored === null) {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const dark = metas.find((m) => m.media.includes('dark'))?.content;
    const light = metas.find((m) => !m.media.includes('dark'))?.content;
    authored = dark !== undefined && light !== undefined ? { light, dark } : null;
  }
  return authored;
}

/** Manual appearance override. 'auto' follows the phone (default); 'light' and
 *  'dark' pin color-scheme via data-theme on <html>, which flips every
 *  light-dark() token in index.css at once. Persisted across visits, and
 *  pre-applied before first paint by the inline script in index.html. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemePref>(() => {
    const stored = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    return 'auto';
  });

  useEffect(() => {
    localStorage.removeItem(LEGACY_KEY); // one-time migration; idempotent
    const root = document.documentElement;
    if (theme === 'auto') {
      delete root.dataset.theme;
      localStorage.removeItem(KEY);
    } else {
      root.dataset.theme = theme;
      localStorage.setItem(KEY, theme);
    }

    // The media-gated <meta name="theme-color"> tags follow the *system*
    // scheme, so when the theme is pinned the browser chrome would disagree
    // with the page — point both at the pinned background instead.
    const bg = backgrounds();
    if (bg !== null) {
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
        const own = m.media.includes('dark') ? bg.dark : bg.light;
        m.content = theme === 'auto' ? own : bg[theme];
      });
    }

    // The favicon: icon.svg adapts by itself in Chromium/Firefox, but Safari
    // ignores media queries inside SVG favicons, and a pinned theme must win
    // over the system scheme everywhere — so resolve the effective scheme here
    // and point the link at the matching variant.
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const applyIcon = () => {
      const dark = theme === 'dark' || (theme === 'auto' && mq.matches);
      const href = ICON[dark ? 'dark' : 'light'];
      if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
    };
    applyIcon();
    mq.addEventListener('change', applyIcon);
    return () => mq.removeEventListener('change', applyIcon);
  }, [theme]);

  return { theme, setTheme };
}

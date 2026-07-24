import { useEffect, useState } from 'react';

export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'umi-theme';
const BG = { light: '#fbfaf7', dark: '#0e0f13' };
const ICON = { light: '/icon.svg?v=4', dark: '/icon-dark.svg?v=4' };

/** Manual appearance override. 'auto' follows the phone (default); 'light' and
 *  'dark' pin color-scheme via data-theme on <html>, which flips every
 *  light-dark() token in index.css at once. Persisted across visits, and
 *  pre-applied before first paint by the inline script in index.html. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemePref>(() => {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  });

  useEffect(() => {
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
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
      const own = m.media.includes('dark') ? BG.dark : BG.light;
      m.content = theme === 'auto' ? own : BG[theme];
    });

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

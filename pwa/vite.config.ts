import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { version } from './package.json';

/**
 * Preload the two font files the app actually renders with.
 *
 * Fonts are declared inside the CSS, so a browser cannot know they exist until
 * the stylesheet has arrived and parsed — one extra round trip before the 80px
 * setpoint numerals stop rendering in the system fallback. The filenames are
 * content-hashed, so the tags cannot be written by hand in index.html; this
 * reads them back off the finished bundle.
 *
 * Latin only, matching the unicode-range in the @font-face rules: the other
 * subsets exist in dist but this app can never draw a glyph from them.
 */
function preloadLatinFonts(): Plugin {
  const isLatinWoff2 = (name: string) =>
    name.endsWith('.woff2') && /-latin-/.test(name) && !/-latin-ext-/.test(name);

  return {
    name: 'preload-latin-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter(isLatinWoff2);
        return fonts.map((file) => ({
          tag: 'link',
          attrs: {
            rel: 'preload',
            as: 'font',
            type: 'font/woff2',
            href: `/${file}`,
            crossorigin: '',
          },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadLatinFonts()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // Baked in at build time so Settings shows when the install was last built,
    // even if the semantic version wasn't bumped.
    __BUILD_DATE__: JSON.stringify(
      new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    ),
  },
  build: {
    // The CSS (light-dark(), oklch) already requires Safari 17.5+, so
    // downleveling the JS below that is pure bundle waste.
    target: 'es2022',
    rollupOptions: {
      output: {
        // Split the two big, rarely-changing libraries into their own chunks.
        // Their content hashes then survive an app update, so bumping the PWA
        // only makes a phone re-fetch the ~13 KB of app code instead of the
        // whole ~100 KB bundle — which matters when the server is a Pi on
        // 2.4 GHz Wi-Fi.
        manualChunks: {
          react: ['react', 'react-dom', 'react/jsx-runtime'],
          motion: ['framer-motion'],
        },
      },
    },
  },
  server: {
    // Expose on the LAN so you can install the PWA from a phone during dev.
    host: true,
    port: 5173,
  },
});

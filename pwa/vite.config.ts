import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { version } from './package.json';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // Baked in at build time so Settings shows when the install was last built,
    // even if the semantic version wasn't bumped.
    __BUILD_DATE__: JSON.stringify(
      new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    ),
  },
  build: {
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

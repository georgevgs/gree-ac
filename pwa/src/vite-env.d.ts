/// <reference types="vite/client" />

/** Injected at build time from package.json (vite.config.ts `define`). */
declare const __APP_VERSION__: string;
/** Build date, injected at build time (vite.config.ts `define`). */
declare const __BUILD_DATE__: string;

interface ImportMetaEnv {
  /** Base URL of the bridge service. Empty = same origin (bridge serves the PWA). */
  readonly VITE_BRIDGE_URL?: string;
  /** Display name for the unit shown in the header and Settings. Default "AC". */
  readonly VITE_DEVICE_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

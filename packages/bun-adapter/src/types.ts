/** Build-time configuration passed to the server entrypoint via virtual module. */
export type AdapterOptions = {
  /** Hostname or boolean (`true` = `"0.0.0.0"`, `false` = `"localhost"`). */
  host: string | boolean;
  /** Port the server listens on. */
  port: number;
  /** Absolute `file://` URL to `dist/client/`. */
  client: string;
  /** Absolute `file://` URL to `dist/server/`. */
  server: string;
  /** Relative path to adapter directory within `dist/server/`. */
  adapterDir: string;
  /** Name of the assets directory (default `_astro`). */
  assets: string;
  /** `Cache-Control` header for non-hashed static assets. */
  staticCacheControl: string;
  /** Image endpoint route with leading slash (e.g. `"/_image"`). */
  imageEndpointRoute: string;
  /** ISR configuration. `false` disables ISR. */
  isr: false | ISROptions;
};

/** Resolved ISR configuration. */
export type ISROptions = {
  maxByteSize: number;
  cacheDir?: string;
  preFillMemoryCache: boolean;
};

/** A cached SSR response with timing metadata for fresh/stale/expired checks. */
export type ISRCacheEntry = {
  body: Uint8Array;
  headers: [string, string][];
  status: number;
  cachedAt: number;
  /** `s-maxage` in seconds — defines the fresh window. */
  sMaxAge: number;
  /** `stale-while-revalidate` in seconds — defines the stale window. */
  swr: number;
};

/** Pre-computed response headers for a static file. */
export type ManifestEntry = {
  headers: Record<string, string>;
  /** Relative file path within client dir. */
  filePath: string;
};

export type StaticManifest = Record<string, ManifestEntry>;

/** Minimal cache interface for on-demand expiration. */
export type ISRCache = {
  expire: (key: string) => Promise<void>;
  expireAll: () => Promise<void>;
};

/** ISR request handler with shutdown and cache access. */
export type ISRHandler = {
  (request: Request, cacheKey: string): Promise<Response>;
  shutdown: () => Promise<void>;
  cache: ISRCache;
};

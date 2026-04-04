import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — virtual module injected at build time
import options from 'virtual:@scale.digital/astro-bun/config';
import { createApp } from 'astro/app/entrypoint';
import { setGetEnv } from 'astro/env/setup';
import { registerCache } from './cache.ts';
import { createISRHandler } from './isr/handler.ts';
import type { AdapterOptions, ISRHandler, ManifestEntry } from './types.ts';

const CACHE_HEADER = 'x-astro-cache';

setGetEnv((key) => process.env[key]);

const IMAGE_PARAMS = [
  'background',
  'f',
  'fit',
  'h',
  'href',
  'position',
  'q',
  'w',
];

function buildImageCacheKey(pathname: string, params: URLSearchParams): string {
  const normalized = new URLSearchParams();
  for (const key of IMAGE_PARAMS) {
    const value = params.get(key);
    if (value !== null) normalized.set(key, value);
  }
  const qs = normalized.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// --- Auto-start ---

const config = options as AdapterOptions;
const app = createApp();
const logger = app.getAdapterLogger();

const ssrHandler = async (request: Request): Promise<Response> => {
  const routeData = app.match(request);
  if (!routeData) {
    return app.render(request, { addCookieHeader: true });
  }
  return app.render(request, { addCookieHeader: true, routeData });
};

const serverDir = fileURLToPath(new URL('.', import.meta.url));
const clientDir = join(serverDir, '..', 'client');
const adapterDir = join(serverDir, config.adapterDir);
const staticManifest = new Map<string, ManifestEntry>(
  Object.entries(
    JSON.parse(readFileSync(join(adapterDir, 'static-manifest.json'), 'utf-8')),
  ),
);

let isr: ISRHandler | undefined;
if (config.isr) {
  const buildId = readFileSync(join(adapterDir, 'build-id'), 'utf-8').trim();
  const cacheDir = config.isr.cacheDir ?? join(adapterDir, 'isr-cache');
  isr = createISRHandler({
    origin: ssrHandler,
    maxByteSize: config.isr.maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache: config.isr.preFillMemoryCache,
    imageEndpointRoute: config.imageEndpointRoute,
  });
  registerCache(isr.cache);
}

if (isr) {
  const shutdown = () => {
    isr
      ?.shutdown()
      .catch((err: unknown) => console.error('ISR flush failed:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const port = Number(process.env.PORT || config.port || 4321);
const host =
  process.env.HOST ??
  (typeof config.host === 'boolean'
    ? config.host
      ? '0.0.0.0'
      : 'localhost'
    : config.host);

Bun.serve({
  port,
  hostname: host,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'GET' || request.method === 'HEAD') {
      const meta = staticManifest.get(pathname);
      if (meta) {
        const headers = new Headers(meta.headers);
        headers.set(CACHE_HEADER, 'STATIC');

        if (request.headers.get('if-none-match') === meta.headers.ETag) {
          headers.delete('Content-Length');
          headers.delete('Content-Type');
          return new Response(null, { status: 304, headers });
        }

        return new Response(Bun.file(join(clientDir, meta.filePath)), {
          status: 200,
          headers,
        });
      }
    }

    if (!isr || request.method !== 'GET') {
      const response = await ssrHandler(request);
      response.headers.set(CACHE_HEADER, 'BYPASS');
      return response;
    }

    const cacheKey = pathname.startsWith(config.imageEndpointRoute)
      ? buildImageCacheKey(pathname, url.searchParams)
      : pathname;
    return isr(request, cacheKey);
  },
});

logger.info(`Server listening on http://${host}:${port}`);

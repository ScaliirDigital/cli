import type { ISRCache, ISRCacheEntry, ISRHandler } from '../types.ts';
import { createPersistentLRUCache, type PersistentLRUCache } from './cache.ts';

/** Cache status header. */
const CACHE_HEADER = 'x-astro-cache';

/** Check whether a cache key belongs to the image optimization endpoint. */
function isImageEndpointKey(key: string, route: string): boolean {
  return key === route || key.startsWith(`${route}?`);
}

/**
 * Override for image endpoint responses — Astro hardcodes `max-age=31536000`
 * without `s-maxage`, so images would always bypass ISR without this.
 */
const IMAGE_CACHE_CONTROL =
  'public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400';

/** Extract a numeric directive value from a Cache-Control header string. */
function parseDirective(header: string, name: string): number | undefined {
  const regex = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i');
  const match = header.match(regex);
  return match ? Number(match[1]) : undefined;
}

/** Build an ISR cache entry from response headers if `s-maxage` is present. */
function buildCacheEntry(
  headers: [string, string][],
  status: number,
  body: Uint8Array,
): ISRCacheEntry | undefined {
  const ccHeader = headers.find(([n]) => n === 'cache-control')?.[1] ?? '';
  const sMaxAge = parseDirective(ccHeader, 's-maxage');
  if (!sMaxAge || sMaxAge <= 0) return undefined;

  return {
    body,
    headers,
    status,
    cachedAt: Date.now(),
    sMaxAge,
    swr: parseDirective(ccHeader, 'stale-while-revalidate') ?? 0,
  };
}

type CacheStatus = 'HIT' | 'STALE' | 'MISS' | 'BYPASS';

/** Reconstruct a Response from a cached entry. */
function responseFromEntry(
  entry: ISRCacheEntry,
  status: CacheStatus,
): Response {
  const response = new Response(entry.body, {
    status: entry.status,
    headers: entry.headers,
  });
  response.headers.set(CACHE_HEADER, status);
  return response;
}

type RenderResult = {
  streaming: Promise<Response>;
  entry: Promise<ISRCacheEntry | undefined>;
};

/** Render via SSR, cache if eligible, return streaming response + cache entry promise. */
function renderToEntry(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  cache: PersistentLRUCache,
  cacheKey: string,
  cacheStatus: CacheStatus,
  imageEndpointRoute: string,
): RenderResult {
  const done = handler(request).then((response) => {
    const clone = response.clone();
    const headers: [string, string][] = Array.from(clone.headers.entries());

    // Override image endpoint cache-control for ISR compatibility.
    if (isImageEndpointKey(cacheKey, imageEndpointRoute)) {
      for (let i = 0; i < headers.length; i++) {
        if (headers[i]?.[0] === 'cache-control') {
          headers[i] = ['cache-control', IMAGE_CACHE_CONTROL];
          break;
        }
      }
    }

    const entryPromise = clone.arrayBuffer().then(async (buf) => {
      const body = new Uint8Array(buf);
      const entry = buildCacheEntry(headers, clone.status, body);
      if (entry) await cache.set(cacheKey, entry);
      return entry;
    });

    response.headers.set(CACHE_HEADER, cacheStatus);
    return { response, entryPromise };
  });

  return {
    streaming: done.then(({ response }) => response),
    entry: done.then(({ entryPromise }) => entryPromise),
  };
}

type ISRHandlerOptions = {
  origin: (request: Request) => Promise<Response>;
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  preFillMemoryCache: boolean;
  imageEndpointRoute: string;
};

/** Create an ISR handler with LRU caching, stale-while-revalidate, and request coalescing. */
export function createISRHandler(options: ISRHandlerOptions): ISRHandler {
  const {
    origin,
    maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache,
    imageEndpointRoute,
  } = options;

  const cache = createPersistentLRUCache({
    maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache,
  });
  const revalidating = new Set<string>();
  const inflight = new Map<string, Promise<ISRCacheEntry | undefined>>();

  const handler = (async (request: Request, cacheKey: string) => {
    const entry = await cache.get(cacheKey);

    if (entry) {
      const elapsed = Date.now() - entry.cachedAt;

      // Fresh — serve from cache.
      if (elapsed < entry.sMaxAge * 1000) {
        return responseFromEntry(entry, 'HIT');
      }

      // Stale — serve stale, background revalidate (one per key).
      if (elapsed < (entry.sMaxAge + entry.swr) * 1000) {
        if (!revalidating.has(cacheKey)) {
          revalidating.add(cacheKey);
          const result = renderToEntry(
            new Request(request.url, request),
            origin,
            cache,
            cacheKey,
            'STALE',
            imageEndpointRoute,
          );
          result.entry
            .catch(() => {})
            .finally(() => revalidating.delete(cacheKey));
        }
        return responseFromEntry(entry, 'STALE');
      }

      // Expired beyond SWR — evict and re-render.
      await cache.delete(cacheKey);
    }

    // Cache miss — deduplicate concurrent requests for same key.
    const pending = inflight.get(cacheKey);
    if (!pending) {
      const result = renderToEntry(
        request,
        origin,
        cache,
        cacheKey,
        'MISS',
        imageEndpointRoute,
      );
      inflight.set(cacheKey, result.entry);
      result.entry.finally(() => inflight.delete(cacheKey));
      return result.streaming;
    }

    // Subsequent callers wait for the in-flight render.
    const cached = await pending;
    if (cached) return responseFromEntry(cached, 'MISS');

    // Not cacheable — direct SSR.
    const response = await origin(request);
    response.headers.set(CACHE_HEADER, 'BYPASS');
    return response;
  }) as ISRHandler;

  handler.shutdown = () => cache.save();
  handler.cache = {
    expire: (key) => cache.delete(key),
    expireAll: async () => {
      const deletes: Promise<void>[] = [];
      for (const key of [...cache.keys]) {
        if (isImageEndpointKey(key, imageEndpointRoute)) continue;
        deletes.push(cache.delete(key));
      }
      await Promise.all(deletes);
    },
  } satisfies ISRCache;

  return handler;
}

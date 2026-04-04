import type { ISRCache } from './types.ts';

const CACHE_KEY = Symbol.for('@scale.digital/astro-bun:isr-cache');

/** Register the ISR cache instance on globalThis for cross-module access. */
export function registerCache(instance: ISRCache): void {
  (globalThis as Record<symbol, unknown>)[CACHE_KEY] = instance;
}

function getCache(): ISRCache | undefined {
  return (globalThis as Record<symbol, unknown>)[CACHE_KEY] as
    | ISRCache
    | undefined;
}

/**
 * Expire an ISR cache entry by pathname. The entry is deleted and
 * will be re-rendered on the next request (lazy revalidation).
 *
 * No-op when ISR is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expirePath } from "@scale.digital/astro-bun/cache";
 * await unstable_expirePath("/blog/my-post");
 * ```
 */
export async function unstable_expirePath(pathname: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.expire(pathname);
}

/**
 * Expire all ISR cache entries. Every cached page is deleted and
 * will be re-rendered on the next request (lazy revalidation).
 *
 * No-op when ISR is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expireAll } from "@scale.digital/astro-bun/cache";
 * await unstable_expireAll();
 * ```
 */
export async function unstable_expireAll(): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.expireAll();
}

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISRCacheEntry } from '../types.ts';

/**
 * Two-tier byte-limited LRU cache (functional).
 *
 * L1: in-memory LRU via doubly-linked list nodes.
 * L2: per-entry JSON files on disk.
 *
 * Evicted entries stay on disk and reload on next get().
 * TTL is not enforced here — the ISR handler checks cachedAt + sMaxAge.
 */

// --- LRU Node types (plain objects, no classes) ---

type BoundaryNode = {
  kind: 'boundary';
  older: LRUNode;
  newer: LRUNode;
};

type CacheNode = {
  kind: 'cache';
  key: string;
  value: ISRCacheEntry;
  size: number;
  older: LRUNode;
  newer: LRUNode;
};

type LRUNode = BoundaryNode | CacheNode;

function createCacheNode(
  key: string,
  value: ISRCacheEntry,
  size: number,
): CacheNode {
  return { kind: 'cache', key, value, size } as CacheNode;
}

function createBoundary(): BoundaryNode {
  const node = { kind: 'boundary' } as BoundaryNode;
  node.older = node;
  node.newer = node;
  return node;
}

function insertAfterHead(head: BoundaryNode, node: CacheNode): void {
  node.older = head;
  node.newer = head.newer;
  head.newer.older = node;
  head.newer = node;
}

function detach(node: CacheNode): void {
  node.older.newer = node.newer;
  node.newer.older = node.older;
}

function promote(head: BoundaryNode, node: CacheNode): void {
  detach(node);
  insertAfterHead(head, node);
}

// --- Cache state ---

type CacheState = {
  entries: Map<string, CacheNode>;
  head: BoundaryNode;
  tail: BoundaryNode;
  currentBytes: number;
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  preFillMemoryCache: boolean;
  entriesDir: string;
  indexPath: string;
  diskKeys: Set<string>;
  hashIndex: Map<string, string>;
  dirReady: boolean;
  indexDirty: boolean;
  indexTimer: ReturnType<typeof setTimeout> | undefined;
  pendingWrites: Set<Promise<void>>;
  pendingLoads: Map<string, Promise<ISRCacheEntry | undefined>>;
  ready: Promise<void> | true;
};

type PersistentLRUCacheOptions = {
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  preFillMemoryCache: boolean;
};

export type PersistentLRUCache = {
  get: (key: string) => Promise<ISRCacheEntry | undefined>;
  set: (key: string, value: ISRCacheEntry) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: ReadonlySet<string>;
  save: () => Promise<void>;
  destroy: () => Promise<void>;
};

// --- Internal helpers ---

function hashPathname(state: CacheState, pathname: string): string {
  const cached = state.hashIndex.get(pathname);
  if (cached) return cached;
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(pathname);
  const hex = hasher.digest('hex');
  state.hashIndex.set(pathname, hex);
  return hex;
}

function entryPath(state: CacheState, hash: string): string {
  return join(state.entriesDir, `${hash}.json`);
}

async function ensureDir(state: CacheState): Promise<void> {
  if (state.dirReady) return;
  await mkdir(state.entriesDir, { recursive: true });
  state.dirReady = true;
}

function evictOverBudget(state: CacheState): void {
  while (state.currentBytes > state.maxByteSize && state.entries.size > 0) {
    const oldest = state.tail.older;
    if (oldest.kind === 'boundary') break;
    detach(oldest);
    state.entries.delete(oldest.key);
    state.currentBytes -= oldest.size;
  }
}

async function persistEntry(
  state: CacheState,
  key: string,
  value: ISRCacheEntry,
): Promise<void> {
  const hash = hashPathname(state, key);
  await ensureDir(state);
  const serializable = {
    ...value,
    body: Array.from(value.body),
  };
  await Bun.write(entryPath(state, hash), JSON.stringify(serializable));
  state.indexDirty = true;
  scheduleIndexWrite(state);
}

async function writeIndex(state: CacheState): Promise<void> {
  if (!state.indexDirty) return;
  const index: Record<string, string> = {};
  for (const [pathname, hash] of state.hashIndex) {
    if (state.diskKeys.has(pathname)) {
      index[hash] = pathname;
    }
  }
  await Bun.write(state.indexPath, JSON.stringify(index));
  state.indexDirty = false;
}

function scheduleIndexWrite(state: CacheState): void {
  if (state.indexTimer || !state.indexDirty) return;
  state.indexTimer = setTimeout(() => {
    state.indexTimer = undefined;
    writeIndex(state).catch(() => {});
  }, 1000);
  state.indexTimer.unref();
}

function clearIndexTimer(state: CacheState): void {
  if (state.indexTimer) {
    clearTimeout(state.indexTimer);
    state.indexTimer = undefined;
  }
}

async function loadFromDisk(
  state: CacheState,
  key: string,
): Promise<ISRCacheEntry | undefined> {
  try {
    const hash = hashPathname(state, key);
    const filePath = entryPath(state, hash);
    const raw = await Bun.file(filePath).text();
    const parsed = JSON.parse(raw);
    const entry: ISRCacheEntry = {
      ...parsed,
      body: new Uint8Array(parsed.body),
    };

    const existing = state.entries.get(key);
    if (existing) {
      promote(state.head, existing);
      return existing.value;
    }

    const size = entry.body.byteLength;
    const node = createCacheNode(key, entry, size);
    state.entries.set(key, node);
    insertAfterHead(state.head, node);
    state.currentBytes += size;
    evictOverBudget(state);

    return entry;
  } catch {
    state.diskKeys.delete(key);
    state.hashIndex.delete(key);
    return undefined;
  } finally {
    state.pendingLoads.delete(key);
  }
}

async function vacuum(state: CacheState): Promise<void> {
  const manifestPath = join(state.cacheDir, 'manifest.json');
  let manifest: { buildIds: string[] } = { buildIds: [] };
  const manifestFile = Bun.file(manifestPath);
  if (await manifestFile.exists()) {
    try {
      manifest = await manifestFile.json();
    } catch {
      /* start fresh */
    }
  }

  for (const oldId of manifest.buildIds) {
    if (oldId === state.buildId) continue;
    await rm(join(state.cacheDir, oldId), { recursive: true, force: true });
  }

  await mkdir(state.cacheDir, { recursive: true });
  await Bun.write(manifestPath, JSON.stringify({ buildIds: [state.buildId] }));
}

async function load(state: CacheState): Promise<void> {
  await vacuum(state);
  await ensureDir(state);

  const indexFile = Bun.file(state.indexPath);
  if (!(await indexFile.exists())) {
    state.ready = true;
    return;
  }

  let index: Record<string, string>;
  try {
    index = await indexFile.json();
  } catch {
    state.ready = true;
    return;
  }

  for (const [hash, pathname] of Object.entries(index)) {
    state.diskKeys.add(pathname);
    state.hashIndex.set(pathname, hash);
  }
  state.ready = true;

  if (state.preFillMemoryCache) {
    void preFill(state, index);
  }
}

async function preFill(
  state: CacheState,
  index: Record<string, string>,
): Promise<void> {
  const BATCH_SIZE = 8;
  const pathnames = Object.values(index);

  for (let i = 0; i < pathnames.length; i += BATCH_SIZE) {
    if (state.currentBytes >= state.maxByteSize) break;

    const batch: Promise<ISRCacheEntry | undefined>[] = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, pathnames.length); j++) {
      const pathname = pathnames[j];
      if (!pathname) continue;
      if (state.entries.has(pathname)) continue;
      if (state.currentBytes >= state.maxByteSize) break;

      const inflight = state.pendingLoads.get(pathname);
      if (inflight) {
        batch.push(inflight);
        continue;
      }

      const p = loadFromDisk(state, pathname);
      state.pendingLoads.set(pathname, p);
      batch.push(p);
    }

    await Promise.all(batch);
  }
}

// --- Public factory ---

/** Create a persistent two-tier LRU cache (L1 memory + L2 disk). */
export function createPersistentLRUCache(
  options: PersistentLRUCacheOptions,
): PersistentLRUCache {
  const head = createBoundary();
  const tail = createBoundary();
  head.newer = tail;
  tail.older = head;

  const state: CacheState = {
    entries: new Map(),
    head,
    tail,
    currentBytes: 0,
    maxByteSize: options.maxByteSize,
    cacheDir: options.cacheDir,
    buildId: options.buildId,
    preFillMemoryCache: options.preFillMemoryCache,
    entriesDir: join(options.cacheDir, options.buildId, 'entries'),
    indexPath: join(options.cacheDir, options.buildId, 'index.json'),
    diskKeys: new Set(),
    hashIndex: new Map(),
    dirReady: false,
    indexDirty: false,
    indexTimer: undefined,
    pendingWrites: new Set(),
    pendingLoads: new Map(),
    ready: true,
  };

  // Start loading immediately.
  state.ready = load(state);

  return {
    async get(key) {
      if (state.ready !== true) await state.ready;
      const node = state.entries.get(key);
      if (node) {
        promote(state.head, node);
        return node.value;
      }
      const inflight = state.pendingLoads.get(key);
      if (inflight) return inflight;
      if (!state.diskKeys.has(key)) return undefined;
      const p = loadFromDisk(state, key);
      state.pendingLoads.set(key, p);
      return p;
    },

    async set(key, value) {
      if (state.ready !== true) await state.ready;
      const size = value.body.byteLength;
      if (size > state.maxByteSize) return;

      const existing = state.entries.get(key);
      if (existing) {
        existing.value = value;
        state.currentBytes = state.currentBytes - existing.size + size;
        existing.size = size;
        promote(state.head, existing);
      } else {
        const node = createCacheNode(key, value, size);
        state.entries.set(key, node);
        insertAfterHead(state.head, node);
        state.currentBytes += size;
      }

      evictOverBudget(state);

      state.diskKeys.add(key);
      const write = persistEntry(state, key, value).catch(() => {});
      state.pendingWrites.add(write);
      void write.finally(() => state.pendingWrites.delete(write));
    },

    async delete(key) {
      if (state.ready !== true) await state.ready;
      const node = state.entries.get(key);
      if (node) {
        detach(node);
        state.entries.delete(key);
        state.currentBytes -= node.size;
      }
      if (state.diskKeys.has(key)) {
        const hash = hashPathname(state, key);
        state.diskKeys.delete(key);
        state.hashIndex.delete(key);
        const removal = rm(entryPath(state, hash), { force: true }).catch(
          () => {},
        );
        state.pendingWrites.add(removal);
        void removal.finally(() => state.pendingWrites.delete(removal));
        state.indexDirty = true;
        scheduleIndexWrite(state);
      }
    },

    get keys() {
      return state.diskKeys as ReadonlySet<string>;
    },

    async save() {
      await Promise.all(state.pendingWrites);
      clearIndexTimer(state);
      await writeIndex(state);
    },

    async destroy() {
      await Promise.all(state.pendingWrites);
      clearIndexTimer(state);
      await writeIndex(state).catch(() => {});
    },
  };
}

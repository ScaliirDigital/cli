import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ISRCacheEntry } from '../types.ts';
import { createPersistentLRUCache } from './cache.ts';

function testCacheDir() {
  return join(
    tmpdir(),
    `cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

const BUILD_ID = 'test-build-id';

function makeEntry(size: number): ISRCacheEntry {
  return {
    body: new Uint8Array(size),
    headers: [],
    status: 200,
    cachedAt: Date.now(),
    sMaxAge: 60,
    swr: 0,
  };
}

describe('createPersistentLRUCache', () => {
  test('get/set — basic storage and retrieval', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    const entry = makeEntry(100);
    await cache.set('a', entry);

    const result = await cache.get('a');
    expect(result?.body.byteLength).toBe(100);

    await cache.destroy();
  });

  test('get — returns undefined for missing key', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    expect(await cache.get('missing')).toBeUndefined();
    await cache.destroy();
  });

  test('delete — removes entry', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.delete('a');

    expect(await cache.get('a')).toBeUndefined();
    await cache.destroy();
  });

  test('eviction — evicts LRU entries when over budget', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.set('b', makeEntry(100));
    await cache.set('c', makeEntry(100));

    expect(await cache.get('b')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();

    await cache.destroy();
  });

  test('LRU promotion — get promotes to MRU', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.set('b', makeEntry(100));

    await cache.get('a');

    await cache.set('c', makeEntry(100));

    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();

    await cache.destroy();
  });

  test('set — updating existing key updates size', async () => {
    const cache = createPersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.set('a', makeEntry(150));
    await cache.set('b', makeEntry(100));

    expect(await cache.get('b')).toBeDefined();

    await cache.destroy();
  });

  test('persistence — save and reload', async () => {
    const dir = testCacheDir();

    const cache1 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache1.set('a', {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set('b', {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    await cache1.destroy();

    const cache2 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    const a = await cache2.get('a');
    expect(a?.body).toBeDefined();
    expect(Array.from(a?.body ?? [])).toEqual([1, 2, 3]);

    const b = await cache2.get('b');
    expect(b?.body).toBeDefined();
    expect(Array.from(b?.body ?? [])).toEqual([4, 5, 6]);

    await cache2.destroy();
  });

  test('persistence — corrupted index starts fresh', async () => {
    const dir = testCacheDir();

    mkdirSync(join(dir, BUILD_ID), { recursive: true });
    await Bun.write(join(dir, BUILD_ID, 'index.json'), 'not valid json');

    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    expect(await cache.get('anything')).toBeUndefined();
    await cache.destroy();
  });

  test('persistence — respects maxByteSize on load', async () => {
    const dir = testCacheDir();

    const cache1 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache1.set('a', makeEntry(100));
    await cache1.set('b', makeEntry(100));
    await cache1.set('c', makeEntry(100));
    await cache1.save();
    await cache1.destroy();

    const cache2 = createPersistentLRUCache({
      maxByteSize: 200,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    expect(await cache2.get('a')).toBeDefined();
    expect(await cache2.get('b')).toBeDefined();

    await cache2.destroy();
  });

  test('disk fallback — evicted entries are retrievable from disk', async () => {
    const dir = testCacheDir();
    const cache = createPersistentLRUCache({
      maxByteSize: 200,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.set('b', makeEntry(100));
    await cache.set('c', makeEntry(100));
    await cache.save();

    const result = await cache.get('a');
    expect(result).toBeDefined();
    expect(result?.body.byteLength).toBe(100);

    await cache.destroy();
  });

  test('delete — removes entry file from disk', async () => {
    const dir = testCacheDir();
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(100));
    await cache.save();

    const entriesDir = join(dir, BUILD_ID, 'entries');
    const indexBefore = await Bun.file(
      join(dir, BUILD_ID, 'index.json'),
    ).json();
    expect(Object.keys(indexBefore).length).toBe(1);

    await cache.delete('a');
    await cache.save();

    const indexAfter = await Bun.file(join(dir, BUILD_ID, 'index.json')).json();
    expect(Object.keys(indexAfter).length).toBe(0);

    const hash = Object.keys(indexBefore)[0];
    expect(existsSync(join(entriesDir, `${hash}.json`))).toBe(false);

    expect(await cache.get('a')).toBeUndefined();

    await cache.destroy();
  });

  test('concurrent get — deduplicates disk reads for the same key', async () => {
    const dir = testCacheDir();

    const cache1 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set('a', {
      body: new Uint8Array([10, 20, 30]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    await cache1.destroy();

    const cache2 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    const results = await Promise.all([
      cache2.get('a'),
      cache2.get('a'),
      cache2.get('a'),
    ]);

    for (const r of results) {
      expect(r).toBeDefined();
      expect(Array.from(r?.body ?? [])).toEqual([10, 20, 30]);
    }

    await cache2.destroy();
  });

  test('get during pre-fill — returns correct entry', async () => {
    const dir = testCacheDir();

    const cache1 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set('x', {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set('y', {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    await cache1.destroy();

    const cache2 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    const x = await cache2.get('x');
    expect(x).toBeDefined();
    expect(Array.from(x?.body ?? [])).toEqual([1, 2, 3]);

    const y = await cache2.get('y');
    expect(y).toBeDefined();
    expect(Array.from(y?.body ?? [])).toEqual([4, 5, 6]);

    await cache2.destroy();
  });

  test('preFillMemoryCache false — skips pre-fill but disk fallback works', async () => {
    const dir = testCacheDir();

    const cache1 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set('a', {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set('b', {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    await cache1.destroy();

    const cache2 = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    const a = await cache2.get('a');
    expect(a).toBeDefined();
    expect(Array.from(a?.body ?? [])).toEqual([1, 2, 3]);

    const b = await cache2.get('b');
    expect(b).toBeDefined();
    expect(Array.from(b?.body ?? [])).toEqual([4, 5, 6]);

    await cache2.destroy();
  });

  test('save — drains all pending writes before flushing index', async () => {
    const dir = testCacheDir();
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('a', makeEntry(50));
    await cache.set('b', makeEntry(50));
    await cache.set('c', makeEntry(50));

    await cache.save();

    const index = await Bun.file(join(dir, BUILD_ID, 'index.json')).json();
    expect(Object.keys(index).length).toBe(3);

    const entriesDir = join(dir, BUILD_ID, 'entries');
    for (const hash of Object.keys(index)) {
      expect(existsSync(join(entriesDir, `${hash}.json`))).toBe(true);
    }

    await cache.destroy();
  });

  test('individual entry files — each set creates a .json file', async () => {
    const dir = testCacheDir();
    const cache = createPersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set('x', makeEntry(50));
    await cache.set('y', makeEntry(50));
    await cache.save();

    const index = await Bun.file(join(dir, BUILD_ID, 'index.json')).json();
    const hashes = Object.keys(index);
    expect(hashes.length).toBe(2);

    const entriesDir = join(dir, BUILD_ID, 'entries');
    for (const hash of hashes) {
      expect(existsSync(join(entriesDir, `${hash}.json`))).toBe(true);
    }

    await cache.destroy();
  });

  describe('vacuum', () => {
    test('removes old build directories on new cache creation', async () => {
      const dir = testCacheDir();

      const cache1 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: 'build-a',
        preFillMemoryCache: false,
      });
      await cache1.set('a', makeEntry(50));
      await cache1.save();
      await cache1.destroy();

      expect(existsSync(join(dir, 'build-a'))).toBe(true);

      const cache2 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: 'build-b',
        preFillMemoryCache: false,
      });
      await cache2.get('anything');

      expect(existsSync(join(dir, 'build-a'))).toBe(false);
      expect(existsSync(join(dir, 'build-b'))).toBe(true);

      await cache2.destroy();
    });

    test('corrupted manifest.json allows fresh start', async () => {
      const dir = testCacheDir();
      mkdirSync(dir, { recursive: true });
      await Bun.write(join(dir, 'manifest.json'), 'not valid json');

      const cache = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });

      await cache.set('a', makeEntry(50));
      expect(await cache.get('a')).toBeDefined();

      await cache.destroy();
    });

    test('current build directory is preserved during vacuum', async () => {
      const dir = testCacheDir();

      const cache1 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });
      await cache1.set('a', makeEntry(50));
      await cache1.save();
      await cache1.destroy();

      const cache2 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });

      const a = await cache2.get('a');
      expect(a).toBeDefined();
      expect(a?.body.byteLength).toBe(50);

      await cache2.destroy();
    });

    test('preserves orphaned directories not in manifest', async () => {
      const dir = testCacheDir();

      const cache1 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });
      await cache1.set('a', makeEntry(50));
      await cache1.save();
      await cache1.destroy();

      mkdirSync(join(dir, 'orphaned-build'), { recursive: true });
      expect(existsSync(join(dir, 'orphaned-build'))).toBe(true);

      const cache2 = createPersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: 'new-build',
        preFillMemoryCache: false,
      });
      await cache2.get('anything');

      expect(existsSync(join(dir, 'orphaned-build'))).toBe(true);
      expect(existsSync(join(dir, BUILD_ID))).toBe(false);
      expect(existsSync(join(dir, 'new-build'))).toBe(true);

      await cache2.destroy();
    });
  });
});

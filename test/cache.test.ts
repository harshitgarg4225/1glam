import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/services/cache.js";

test("TtlCache returns cached value within TTL and expires after", async () => {
  const cache = new TtlCache<string>(50);
  cache.set("k", "v");
  assert.equal(cache.get("k"), "v");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cache.get("k"), undefined);
});

test("TtlCache delete and deleteWhere remove entries", () => {
  const cache = new TtlCache<number>(10_000);
  cache.set("a:1", 1);
  cache.set("a:2", 2);
  cache.set("b:1", 3);
  cache.delete("a:1");
  assert.equal(cache.get("a:1"), undefined);
  cache.deleteWhere((k) => k.startsWith("a:"));
  assert.equal(cache.get("a:2"), undefined);
  assert.equal(cache.get("b:1"), 3);
});

test("TtlCache getOrLoad coalesces concurrent loads into one", async () => {
  const cache = new TtlCache<string>(10_000);
  let loads = 0;
  const loader = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return "loaded";
  };
  const [a, b, c] = await Promise.all([
    cache.getOrLoad("k", loader),
    cache.getOrLoad("k", loader),
    cache.getOrLoad("k", loader),
  ]);
  assert.equal(a, "loaded");
  assert.equal(b, "loaded");
  assert.equal(c, "loaded");
  assert.equal(loads, 1, "three concurrent callers should share one load");
  // And a follow-up read hits the cache, not the loader.
  assert.equal(await cache.getOrLoad("k", loader), "loaded");
  assert.equal(loads, 1);
});

test("TtlCache getOrLoad does not cache loader failures", async () => {
  const cache = new TtlCache<string>(10_000);
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("boom");
  };
  await assert.rejects(cache.getOrLoad("k", failing), /boom/);
  // A failed load must not poison the key — the next call retries.
  await assert.rejects(cache.getOrLoad("k", failing), /boom/);
  assert.equal(calls, 2);
});

test("TtlCache caches null as a real value (negative caching)", async () => {
  const cache = new TtlCache<string | null>(10_000);
  let loads = 0;
  const loader = async () => {
    loads++;
    return null;
  };
  assert.equal(await cache.getOrLoad("missing", loader), null);
  assert.equal(await cache.getOrLoad("missing", loader), null);
  assert.equal(loads, 1, "null result should be cached, not re-loaded");
});

test("TtlCache evicts oldest entry at the size bound instead of growing forever", () => {
  const cache = new TtlCache<number>(10_000);
  for (let i = 0; i < 2001; i++) cache.set(`k${i}`, i);
  assert.equal(cache.get("k0"), undefined, "oldest entry evicted");
  assert.equal(cache.get("k2000"), 2000, "newest entry kept");
});

// Exercise the production cache against a mocked native IPC boundary. Query
// deduplication, observers and persistence use the real TanStack implementation.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";
import { QueryObserver } from "@tanstack/react-query";

const disk = new Map();
const scopes = new Map([["a", "scope-a"], ["b", "scope-b"]]);
globalThis.window = new EventTarget();
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  if (command === "manager_cache_scope") return scopes.get(args.endpointId);
  if (scopes.get(args.endpointId) !== args.sessionScope) throw new Error("cache scope changed");
  const key = [args.endpointId, args.sessionScope, args.resource].join(":");
  if (command === "manager_cache_get") return structuredClone(disk.get(key) ?? null);
  if (command === "manager_cache_set") { if (args.value === null) disk.delete(key); else disk.set(key, structuredClone(args.value)); return; }
  throw new Error(`Unexpected command: ${command}`);
} };
const directory = new URL("../node_modules/.cache/producer-cache-test/", import.meta.url);
await mkdir(directory, { recursive: true });
const modulePath = new URL("cache.mjs", directory);
const source = await readFile(new URL("../src/features/manager/cache.ts", import.meta.url), "utf8");
const result = await transformWithEsbuild(source, "cache.ts", { loader: "ts", format: "esm", target: "es2022" });
await writeFile(modulePath, result.code);
const cache = await import(pathToFileURL(modulePath.pathname).href);
const endpoint = (id) => ({ id, kind: "connected", base_url: "https://example.com", name: id, brand_slug: id, created_at: "" });
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const change = (id, clear = true) => window.dispatchEvent(new CustomEvent(cache.CACHE_EVENT, { detail: { endpointId: id, clear } }));
const flush = async () => { window.dispatchEvent(new Event("blur")); await wait(); };

try {
  const [first, duplicate] = await Promise.all([cache.openManagerSession(endpoint("a")), cache.openManagerSession(endpoint("a"))]);
  assert.equal(first, duplicate, "concurrent mounts share one client");
  assert.equal(cache.peekManagerSession(endpoint("a")), first, "warm return can render before local scope IPC completes");
  assert.equal(cache.peekManagerSession({ ...endpoint("a"), base_url: "https://other.test" }), null, "host changes cannot reuse the warm session");
  let reads = 0;
  let resolve;
  const fetcher = () => { reads++; return new Promise((done) => { resolve = done; }); };
  const request = first.client.fetchQuery({ queryKey: cache.managerKeys.units, queryFn: fetcher });
  const simultaneous = first.client.fetchQuery({ queryKey: cache.managerKeys.units, queryFn: fetcher });
  resolve([{ id: "unit", stage: "draft" }]);
  await Promise.all([request, simultaneous]);
  assert.equal(reads, 1, "duplicate reads coalesce");
  const returning = await cache.openManagerSession(endpoint("a"));
  assert.equal(returning, first, "tab switches retain the client");
  await returning.client.fetchQuery({ queryKey: cache.managerKeys.units, queryFn: fetcher });
  assert.equal(reads, 1, "fresh tab return performs no inventory fetch");
  const observer = new QueryObserver(first.client, { queryKey: cache.managerKeys.units, queryFn: fetcher });
  const unsubscribe = observer.subscribe(() => {});
  assert.equal(observer.getCurrentResult().isPending, false, "warm mount has no loading state");
  unsubscribe();

  first.client.setQueryData(cache.managerKeys.units, [{ id: "unit", stage: "draft" }], { updatedAt: Date.now() - 130_000 });
  const stale = new QueryObserver(first.client, { queryKey: cache.managerKeys.units, queryFn: fetcher });
  const stop = stale.subscribe(() => {});
  await wait();
  assert.equal(stale.getCurrentResult().data[0].stage, "draft", "stale refresh keeps known content visible");
  assert.equal(stale.getCurrentResult().isPending, false);
  resolve([{ id: "unit", stage: "published" }]); await wait(); stop();

  // Cancel a pre-edit response before writing the acknowledged mutation result.
  await first.client.invalidateQueries({ queryKey: cache.managerKeys.units, refetchType: "none" });
  const old = first.client.fetchQuery({ queryKey: cache.managerKeys.units, queryFn: ({ signal }) => {
    return new Promise((done) => { resolve = () => { signal.throwIfAborted(); done([{ id: "unit", stage: "draft" }]); }; });
  } }).catch(() => {});
  await first.client.cancelQueries({ queryKey: cache.managerKeys.units });
  first.client.setQueryData(cache.managerKeys.units, [{ id: "unit", stage: "published", title: "New name" }]);
  assert.throws(() => resolve(), /abort/i); await old;
  assert.equal(first.client.getQueryData(cache.managerKeys.units)[0].title, "New name");

  await first.client.invalidateQueries({ queryKey: cache.managerKeys.units, refetchType: "none" });
  await assert.rejects(first.client.fetchQuery({ queryKey: cache.managerKeys.units, retry: false, queryFn: async () => { throw new Error("offline"); } }));
  assert.equal(first.client.getQueryData(cache.managerKeys.units)[0].title, "New name", "offline keeps known data");
  first.client.setQueryData(["local-recordings"], [{ path: "/private/local/video.mp4" }]);
  first.saveNavigation({ location: { view: "unit", unitId: "unit", returnTo: { view: "overview" } }, overviewTab: "home", unitTabs: { unit: "insights" }, scroll: { unit: { panel: 230 } } });
  await flush();
  const persisted = disk.get("a:scope-a:queries");
  assert.equal(persisted.clientState.queries.length, 1, "local recording paths are not persisted");
  assert.equal(persisted.clientState.queries[0].state.status, "success", "transient errors are not restored as permanent errors");

  change("a");
  assert.equal(cache.peekManagerSession(endpoint("a")), null, "disconnect immediately removes warm sessions");
  const restarted = await cache.openManagerSession(endpoint("a"));
  assert.notEqual(restarted, first);
  assert.equal(restarted.client.getQueryData(cache.managerKeys.units)[0].title, "New name", "disk restores content after memory loss");
  assert.equal(restarted.navigation.unitTabs.unit, "insights");
  assert.equal(restarted.navigation.scroll.unit.panel, 230);
  const other = await cache.openManagerSession(endpoint("b"));
  assert.equal(other.client.getQueryData(cache.managerKeys.units), undefined, "workspace isolation");
  scopes.set("a", "new-account"); change("a");
  const newAccount = await cache.openManagerSession(endpoint("a"));
  assert.equal(newAccount.client.getQueryData(cache.managerKeys.units), undefined, "credential rotation cannot restore prior account");
  assert.equal(newAccount.navigation, undefined);

  change("a");
  disk.set("a:new-account:queries", { ...persisted, timestamp: Date.now() - cache.CACHE_MAX_AGE - 1 });
  const expired = await cache.openManagerSession(endpoint("a"));
  assert.equal(expired.client.getQueryData(cache.managerKeys.units), undefined, "expired snapshots are discarded");
  change("a"); change("b");
  console.log("Manager cache checks passed: deduplication, tab return, background refresh, mutation races, offline persistence, navigation, workspace/session isolation and expiry.");
} finally {
  change("a"); change("b");
  await rm(modulePath, { force: true });
}

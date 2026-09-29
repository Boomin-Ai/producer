import { invoke } from "@tauri-apps/api/core";
import { focusManager, QueryClient } from "@tanstack/react-query";
import { persistQueryClient, type Persister, type PersistedClient } from "@tanstack/react-query-persist-client";
import type { EndpointInfo } from "../../lib/ipc";
import type { ManagerLocation } from "./navigation";

export const CACHE_EVENT = "producer:cache-change";
export const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
export const managerKeys = {
  collections: ["manager", "collections"] as const,
  units: ["manager", "units"] as const,
  posts: ["manager", "posts"] as const,
  recordings: ["manager", "recordings"] as const,
  channels: ["manager", "channels"] as const,
  storage: ["manager", "storage"] as const,
  media: (id: string) => ["manager", "media", id] as const,
  comments: (postId: string) => ["manager", "comments", postId] as const,
};
export interface ManagerNavigation {
  location: ManagerLocation;
  overviewTab: "home" | "collections" | "monitor";
  unitTabs: Record<string, "overview" | "insights" | "comments">;
  scroll: Record<string, Record<string, number>>;
}
export interface ManagerSession {
  endpointId: string;
  endpointIdentity: string;
  scope: string;
  client: QueryClient;
  navigation?: ManagerNavigation;
  saveNavigation: (value: ManagerNavigation) => void;
  dispose: () => void;
}
const sessions = new Map<string, ManagerSession>();
const opening = new Map<string, Promise<ManagerSession>>();
const revisions = new Map<string, number>();
const endpointIdentity = (endpoint: EndpointInfo) => JSON.stringify([endpoint.id, endpoint.base_url, endpoint.brand_slug ?? null]);

/** A session already validated in this window can render synchronously. Auth
 * commands clear it before returning; mount also verifies the native scope. */
export function peekManagerSession(endpoint: EndpointInfo): ManagerSession | null {
  return [...sessions.values()].find((session) => session.endpointIdentity === endpointIdentity(endpoint)) ?? null;
}

// Desktop window focus does not always produce a visibilitychange event.
focusManager.setEventListener((focused) => {
  const focus = () => focused(true);
  const blur = () => focused(false);
  const visibility = () => focused(typeof document === "undefined" || document.visibilityState !== "hidden");
  const visibilityTarget = typeof document === "undefined" ? window : document;
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  visibilityTarget.addEventListener("visibilitychange", visibility);
  return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); visibilityTarget.removeEventListener("visibilitychange", visibility); };
});

function disk(endpointId: string, sessionScope: string, resource: "queries" | "navigation") {
  let pending: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  let disposed = false;
  const write = (value: unknown) => {
    chain = chain.then(async () => {
      if (disposed) return;
      await invoke("manager_cache_set", { endpointId, sessionScope, resource, value }).catch(() => {});
    });
    return chain;
  };
  return {
    async read<T>(): Promise<T | undefined> {
      return (await invoke<T | null>("manager_cache_get", { endpointId, sessionScope, resource }).catch(() => null)) ?? undefined;
    },
    save(value: unknown) {
      pending = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void write(pending); }, 400);
    },
    async clear() { if (timer) clearTimeout(timer); timer = undefined; await write(null); },
    flush() { if (timer) { clearTimeout(timer); timer = undefined; void write(pending); } },
    dispose() { disposed = true; if (timer) clearTimeout(timer); },
  };
}

/** Scope verification is local IPC; opening a tab never waits on the network. */
export async function openManagerSession(endpoint: EndpointInfo): Promise<ManagerSession> {
  const revision = revisions.get(endpoint.id) ?? 0;
  const scope = await invoke<string>("manager_cache_scope", { endpointId: endpoint.id });
  if ((revisions.get(endpoint.id) ?? 0) !== revision) throw new Error("Workspace credentials changed. Please reopen Producer.");
  for (const [key, previous] of sessions) if (previous.endpointId === endpoint.id && key !== scope) { previous.dispose(); sessions.delete(key); }
  const existing = sessions.get(scope);
  if (existing) return existing;
  const running = opening.get(scope);
  if (running) return running;
  const work = (async () => {
    const queries = disk(endpoint.id, scope, "queries");
    const navigation = disk(endpoint.id, scope, "navigation");
    const client = new QueryClient({ defaultOptions: { queries: {
      staleTime: 120_000, gcTime: CACHE_MAX_AGE,
      refetchOnWindowFocus: true, refetchOnReconnect: true,
      retry: (count, error) => count < 1 && !/HTTP (401|403|404)|invalid|Unsupported/i.test(String(error)),
    }, mutations: { retry: false } } });
    let lastSignature = "";
    const persister: Persister = {
      persistClient: (value) => {
        // Local catalog polling and fetch-status notifications must not rewrite
        // the entire inventory. Persist only remote data or invalidation changes.
        const signature = JSON.stringify(value.clientState.queries.map((query) => [query.queryHash, query.state.dataUpdatedAt, query.state.dataUpdateCount, query.state.isInvalidated]));
        if (signature === lastSignature) return;
        lastSignature = signature;
        queries.save({ ...value, clientState: { ...value.clientState, queries: value.clientState.queries.map((query) => ({
          ...query, state: { ...query.state, status: "success", fetchStatus: "idle", error: null, fetchFailureCount: 0, fetchFailureReason: null },
        })) } });
      },
      restoreClient: () => queries.read<PersistedClient>(),
      removeClient: () => queries.clear(),
    };
    const [unsubscribe, restored] = persistQueryClient({ queryClient: client, persister, maxAge: CACHE_MAX_AGE, buster: "manager-v2-original-availability", dehydrateOptions: {
      shouldDehydrateMutation: () => false,
      // Failed background reads retain last-known data across restarts too.
      shouldDehydrateQuery: (query) => query.state.data !== undefined && Date.now() - query.state.dataUpdatedAt < CACHE_MAX_AGE && query.queryKey[0] === "manager",
    } });
    const [savedNavigation] = await Promise.all([navigation.read<ManagerNavigation>(), restored.catch(() => {})]);
    // Cold starts reconcile native outbox replay and edits made in Boomin web.
    // Hydrated content remains visible; warm tab returns reuse this client.
    await client.invalidateQueries({ queryKey: ["manager"], refetchType: "none" });
    if ((revisions.get(endpoint.id) ?? 0) !== revision) {
      unsubscribe(); queries.dispose(); navigation.dispose(); client.clear();
      throw new Error("Workspace disconnected.");
    }
    // Flush the small debounced writes when the app loses focus or closes.
    const flush = () => { queries.flush(); navigation.flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    const session: ManagerSession = {
      endpointId: endpoint.id, endpointIdentity: endpointIdentity(endpoint), scope, client,
      navigation: validNavigation(savedNavigation) ? savedNavigation : undefined,
      saveNavigation(value) { session.navigation = value; navigation.save(value); },
      dispose() { unsubscribe(); queries.dispose(); navigation.dispose(); client.clear(); window.removeEventListener("pagehide", flush); window.removeEventListener("blur", flush); },
    };
    sessions.set(scope, session);
    // Memory is bounded across rarely visited workspaces; disk restores evicted ones.
    if (sessions.size > 8) {
      const oldest = [...sessions.keys()].find((key) => key !== scope)!;
      sessions.get(oldest)?.dispose(); sessions.delete(oldest);
    }
    return session;
  })().finally(() => opening.delete(scope));
  opening.set(scope, work);
  return work;
}

function validNavigation(value: unknown): value is ManagerNavigation {
  if (!value || typeof value !== "object") return false;
  const v = value as ManagerNavigation;
  const parent = (location: unknown): boolean => {
    if (!location || typeof location !== "object") return false;
    const l = location as Record<string, unknown>;
    return l.view === "overview" || (l.view === "collection" && typeof l.collectionId === "string")
      || (l.view === "stages" && ["drafts", "review", "scheduled", "failed", "collabs"].includes(String(l.tab)));
  };
  const unit = (location: unknown): boolean => {
    if (!location || typeof location !== "object") return false;
    const l = location as Record<string, unknown>;
    return l.view === "unit" && typeof l.unitId === "string" && parent(l.returnTo);
  };
  const location = v.location;
  const validLocation = parent(location) || unit(location) || (location?.view === "post" && typeof location.socialPostId === "string" && (parent(location.returnTo) || unit(location.returnTo)));
  return validLocation && ["home", "collections", "monitor"].includes(v.overviewTab)
    && !!v.unitTabs && typeof v.unitTabs === "object" && Object.values(v.unitTabs).every((tab) => ["overview", "insights", "comments"].includes(tab))
    && !!v.scroll && typeof v.scroll === "object" && Object.values(v.scroll).every((positions) => positions && typeof positions === "object" && Object.values(positions).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0));
}

// Publishing and generic CMS writes notify inactive sessions as well. Marking
// stale does not fetch inactive pages; the next visit revalidates them.
function cacheChanged(event: Event) {
  const { endpointId, clear } = (event as CustomEvent<{ endpointId?: string; clear?: boolean }>).detail;
  if (clear && endpointId) revisions.set(endpointId, (revisions.get(endpointId) ?? 0) + 1);
  for (const [scope, session] of sessions) {
    if (endpointId && session.endpointId !== endpointId) continue;
    if (clear) { session.dispose(); sessions.delete(scope); }
    else void session.client.invalidateQueries({ queryKey: ["manager"], refetchType: "none" });
  }
}
window.addEventListener(CACHE_EVENT, cacheChanged);
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener(CACHE_EVENT, cacheChanged);
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
});

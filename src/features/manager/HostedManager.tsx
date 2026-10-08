import { OriginalMediaPanel } from "../../components/OriginalMediaPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, recording, type Channel, type EndpointInfo } from "../../lib/ipc";
import { ManagerShell } from "./ManagerShell";
import type { Collection, ContentUnit } from "./contracts";
import { assembleHostedManager, createHostedCollectionUnit, createHostedLibraryEntry, loadHostedCollections, loadHostedPosts, loadHostedRecordings, loadHostedUnitMedia, loadHostedUnits, mergeLocalRecordings, renameHostedCollection, updateHostedUnit } from "./hosted";
import { PublishComposer } from "./PublishComposer";
import { OVERVIEW } from "./navigation";
import { CACHE_EVENT, managerKeys as keys, openManagerSession, peekManagerSession, type ManagerSession } from "./cache";

type Props = { endpoint: EndpointInfo; channels: Channel[]; onCompose: () => void; initialRecordingId?: string | null; composing?: boolean; onComposeClosed?: () => void; onSubmitted?: () => void };

/** Cached clients outlive this component; only the active page observes reads. */
export function HostedManager(props: Props) {
  const [session, setSession] = useState<ManagerSession | null>(() => peekManagerSession(props.endpoint));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void openManagerSession(props.endpoint).then((value) => { if (alive) setSession(value); }).catch(() => {
      if (alive) { setSession(null); setError("Couldn’t open the local cache. Reopen Producer or retry."); }
    });
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ endpointId?: string; clear?: boolean }>).detail;
      if (detail.clear && (!detail.endpointId || detail.endpointId === props.endpoint.id)) {
        setSession(null); setAttempt((n) => n + 1);
      }
    };
    window.addEventListener(CACHE_EVENT, changed);
    return () => { alive = false; window.removeEventListener(CACHE_EVENT, changed); };
  }, [props.endpoint.id, props.endpoint.base_url, props.endpoint.brand_slug, attempt]);
  // A changed endpoint must never render or edit the previous workspace's cache
  // while its asynchronous session lookup is still resolving.
  if (!session || session.endpointIdentity !== JSON.stringify([props.endpoint.id, props.endpoint.base_url, props.endpoint.brand_slug ?? null])) return <div className="pm-live"><div className="pm-live-message" role={error ? "alert" : "status"}>{error ?? "Opening Producer…"}{error && <button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button>}</div></div>;
  return <QueryClientProvider client={session.client}><CachedManager key={session.scope} {...props} session={session} /></QueryClientProvider>;
}

function CachedManager({ endpoint, channels: initialChannels, onCompose, initialRecordingId, composing, onComposeClosed, onSubmitted, session }: Props & { session: ManagerSession }) {
  const client = useQueryClient();
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(() => !initialRecordingId && session.navigation?.location.view === "unit" ? session.navigation.location.unitId : null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const collections = useQuery({ queryKey: keys.collections, enabled: !accessError, queryFn: ({ signal }) => loadHostedCollections(endpoint.id, signal) });
  const units = useQuery({ queryKey: keys.units, enabled: !accessError, queryFn: ({ signal }) => loadHostedUnits(endpoint.id, signal), refetchInterval: (query) => {
    const rows = query.state.data;
    return rows?.some((unit) => unit.stage === "processing" || unit.distributions?.some((d) => d.status === "processing")) ? 15_000 : false;
  } });
  const posts = useQuery({ queryKey: keys.posts, enabled: !accessError, queryFn: ({ signal }) => loadHostedPosts(endpoint.id, signal) });
  const previousPublishing = useRef<string | null>(null);
  useEffect(() => {
    if (!units.data) return;
    const publishing = JSON.stringify(units.data.map((unit) => [unit.id, unit.stage, unit.postIds, unit.distributions?.map((d) => [d.status, d.publishedPostId])]));
    if (previousPublishing.current !== null && publishing !== previousPublishing.current) void client.invalidateQueries({ queryKey: keys.posts });
    previousPublishing.current = publishing;
  }, [units.data, client]);
  const captures = useQuery({ queryKey: keys.recordings, enabled: !accessError, queryFn: ({ signal }) => loadHostedRecordings(endpoint.id, signal) });
  const channels = useQuery({ queryKey: keys.channels, enabled: !accessError, initialData: initialChannels.length ? initialChannels : undefined,
    initialDataUpdatedAt: 0, staleTime: 300_000, queryFn: async ({ signal }) => {
      const response = await ipc.endpointChannels(endpoint.id); signal.throwIfAborted();
      return response.channels.filter((channel) => channel.status === "active").map((channel) => ({ ...channel, endpoint_id: endpoint.id, endpoint_kind: endpoint.kind }));
    } });
  // Local paths never enter the persisted remote cache.
  const local = useQuery({ queryKey: ["local-recordings"], queryFn: () => recording.list(endpoint.id), staleTime: 0, gcTime: 0, refetchInterval: 10_000 });
  useEffect(() => {
    if (!local.data?.some((row) => row.status === "ready" && !row.unit_id)) return;
    let alive = true;
    void recording.sync(endpoint.id).then(() => {
      if (!alive) return;
      void client.invalidateQueries({ queryKey: ["local-recordings"] });
      for (const key of [keys.recordings, keys.collections, keys.units]) void client.invalidateQueries({ queryKey: key });
    }).catch(() => {});
    return () => { alive = false; };
  }, [endpoint.id, local.data, client]);

  const inventory = useMemo(() => {
    if (!collections.data || !units.data || !posts.data) return null;
    return mergeLocalRecordings(assembleHostedManager(endpoint.name, channels.data ?? initialChannels, collections.data, units.data, posts.data, captures.data ?? { recordings: [] }), local.data ?? []);
  }, [endpoint.name, channels.data, initialChannels, collections.data, units.data, posts.data, captures.data, local.data]);
  const selectedUnit = inventory?.units.find((unit) => unit.id === selectedUnitId);
  const media = useQuery({ queryKey: keys.media(selectedUnitId ?? ""), enabled: !accessError && !!selectedUnitId && !selectedUnit?.recording?.localAvailable,
    staleTime: 60_000, queryFn: ({ signal }) => loadHostedUnitMedia(endpoint.id, selectedUnitId!, signal) });
  const data = useMemo(() => inventory && ({ ...inventory, mediaFiles: [...(inventory.mediaFiles ?? []), ...(media.data ?? [])] }), [inventory, media.data]);

  const createLibrary = useCallback(async (kind: "series" | "featured", name: string, requestId: string) => {
    const created = await createHostedLibraryEntry(endpoint.id, kind, name, requestId);
    // Cancel pre-mutation reads so their older responses cannot undo the write.
    await Promise.all([client.cancelQueries({ queryKey: keys.collections }), client.cancelQueries({ queryKey: keys.units })]);
    client.setQueryData<Collection[]>(keys.collections, (rows = []) => [...rows.filter((row) => row.id !== created.collectionId), { id: created.collectionId, name, kind }]);
    if (created.unitId) client.setQueryData<ContentUnit[]>(keys.units, (rows = []) => [...rows.filter((row) => row.id !== created.unitId), {
      id: created.unitId!, collectionId: created.collectionId, title: name, type: "short-video", stage: "draft", caption: "", partIds: [], postIds: [], selectedChannelIds: [],
    }]);
    void client.invalidateQueries({ queryKey: keys.collections }); void client.invalidateQueries({ queryKey: keys.units });
    return created;
  }, [endpoint.id, client]);
  const createUnit = useCallback(async (collectionId: string) => {
    const unit = await createHostedCollectionUnit(endpoint.id, collectionId);
    await client.cancelQueries({ queryKey: keys.units });
    client.setQueryData<ContentUnit[]>(keys.units, (rows = []) => [...rows.filter((row) => row.id !== unit.id), unit]);
    return unit.id;
  }, [endpoint.id, client]);
  const renameCollection = useCallback(async (collectionId: string, name: string) => {
    await renameHostedCollection(endpoint.id, collectionId, name);
    await client.cancelQueries({ queryKey: keys.collections });
    client.setQueryData<Collection[]>(keys.collections, (rows = []) => rows.map((row) => row.id === collectionId ? { ...row, name } : row));
  }, [endpoint.id, client]);
  const updateUnit = useCallback(async (unitId: string, changes: Partial<ContentUnit>) => {
    const unit = await updateHostedUnit(endpoint.id, unitId, changes);
    await client.cancelQueries({ queryKey: keys.units });
    client.setQueryData<ContentUnit[]>(keys.units, (rows = []) => rows.map((row) => row.id === unitId ? unit : row));
    return unit;
  }, [endpoint.id, client]);

  const resources = [collections, units, posts, captures, channels];
  const error = resources.find((query) => query.error)?.error;
  const denied = [...resources, media].find((query) => /HTTP (401|403)|rejected the token/i.test(String(query.error ?? "")))?.error;
  useEffect(() => {
    if (!denied) return;
    // Do not keep serving private snapshots after an explicit access denial.
    setAccessError(String(denied));
    void client.cancelQueries({ queryKey: ["manager"] }).then(() => client.removeQueries({ queryKey: ["manager"] }));
  }, [denied, client]);
  const updating = resources.some((query) => query.isFetching);
  const refresh = () => { setAccessError(null); void client.invalidateQueries({ queryKey: ["manager"], refetchType: "active" }); void client.invalidateQueries({ queryKey: ["local-recordings"] }); };
  const initialUnit = initialRecordingId ? data?.units.find((unit) => unit.recording?.id === initialRecordingId) : undefined;
  // Room recordings can arrive from local IPC after a warm inventory is ready.
  // Resolve the explicit target before mounting a shell with a saved location.
  const resolvingRecording = !!initialRecordingId && !initialUnit && (local.isPending || local.isFetching || captures.isPending || captures.isFetching);
  return <div className="pm-live">
    {accessError || denied || !data || resolvingRecording ? <div className="pm-live-message" role={error || accessError ? "alert" : "status"}>{error || accessError ? <><h2>Couldn’t load your Boomin content</h2><p>{accessError ?? String(error)}</p><button type="button" onClick={refresh}>Retry</button></> : resolvingRecording ? "Opening recording…" : "Loading collections and posts…"}</div> : <>
      {error && <div className="pm-live-cache-status" role="status">Couldn’t refresh. Showing your last loaded content. <button type="button" onClick={refresh}>Retry</button></div>}
      {media.error && selectedUnitId && <div className="pm-live-cache-status" role="status">Couldn’t refresh this unit’s media. <button type="button" onClick={() => void media.refetch()}>Retry</button></div>}
      <ManagerShell renderOriginalMedia={(post) => <OriginalMediaPanel key={endpoint.id + post.id} endpointId={endpoint.id} post={post} onRestored={() => client.invalidateQueries({ queryKey: ["manager"], refetchType: "active" })} />} headerActions={<button type="button" className="pm-header-refresh" disabled={updating} onClick={refresh}>{updating ? "Updating…" : "Refresh"}</button>} key={composing ? "compose" : `browse-${initialRecordingId ?? "library"}`} data={data} channels={channels.data ?? initialChannels} native onCompose={onCompose} onUnitSelected={setSelectedUnitId} onCreateLibrary={createLibrary} onCreateUnit={createUnit} onRenameCollection={renameCollection} onUpdateUnit={updateUnit}
        onLocationChange={(location) => { if (composing && location.view !== "compose") onComposeClosed?.(); }}
        renderComposer={(onBack) => <PublishComposer endpointId={endpoint.id} channels={channels.data ?? initialChannels} onBack={onBack} onSubmitted={() => { onSubmitted?.(); onBack(); void client.invalidateQueries({ queryKey: ["manager"], refetchType: "active" }); }} />}
        cacheSession={session} initialLocation={composing ? { view: "compose" } : initialUnit ? { view: "unit", unitId: initialUnit.id, returnTo: OVERVIEW } : session.navigation?.location ?? OVERVIEW} />
    </>}
  </div>;
}

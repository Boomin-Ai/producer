import { useEffect, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { guests, storage, type EndpointInfo, type ProducerStorageUsage } from "../lib/ipc";
import { cached, swr } from "../lib/fetchCache";
import { managerKeys, openManagerSession, type ManagerSession } from "../features/manager/cache";

type HostedUsage = {
  total_bytes: string; object_count: number; unknown_size_count: number; external_file_count: number;
  scope: "brand" | "accessible_folders"; measured_at: string;
  categories: Array<{ kind: string; bytes: string; count: number }>;
};
function bytes(value: number | string) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size === 0) return "0 B";
  const index = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}
export function StoragePanel({ endpoint }: { endpoint: EndpointInfo | null }) {
  const [local, setLocal] = useState<ProducerStorageUsage | undefined>(() => cached("producer:storage:v2"));
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; setBusy(true); void swr("producer:storage:v2", storage.localUsage).then((value) => { if (alive) setLocal(value); }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setBusy(false); }); return () => { alive = false; }; }, []);
  async function refresh() { setBusy(true); setError(false); try { setLocal(await swr("producer:storage:v2", storage.localUsage, { force: true })); } catch { setError(true); } finally { setBusy(false); } }
  return <div className="set-storage">
    {endpoint ? <HostedStorage key={JSON.stringify([endpoint.id, endpoint.base_url, endpoint.brand_slug])} endpoint={endpoint} /> : <section className="set-storage-card"><h2>Brand storage</h2><p>Connect a workspace to see hosted media usage.</p></section>}
    <section className="set-storage-card"><div className="set-storage-heading"><h2>This Mac</h2><button className="linkish" disabled={busy} onClick={() => void refresh()}>{busy ? "Measuring…" : "Refresh"}</button></div>
      <strong className="set-storage-total">{local ? bytes(local.total_bytes) : "—"}</strong><p className="set-storage-note">Producer app data and recording files across all workspaces.</p>
      {error && <p role="alert">Couldn’t measure local storage. {local && "Showing the last measurement."}</p>}
      {local && <><dl className="set-storage-rows"><div><dt>App data</dt><dd>{bytes(local.app_data_bytes)}</dd></div><div><dt>Recordings <small>{local.recording_count} files</small></dt><dd>{bytes(local.recording_bytes)}</dd></div></dl><p className="set-storage-note">Recordings inside app data are included once in the total.</p>{(local.missing_recordings > 0 || local.unreadable_entries > 0) && <p className="set-storage-note">{local.missing_recordings} missing recordings · {local.unreadable_entries} unreadable items excluded.</p>}</>}
    </section>
  </div>;
}
function HostedStorage({ endpoint }: { endpoint: EndpointInfo }) {
  const [session, setSession] = useState<ManagerSession | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { let alive = true; void openManagerSession(endpoint).then((value) => { if (alive) setSession(value); }).catch(() => { if (alive) setError(true); }); return () => { alive = false; }; }, [endpoint]);
  if (!session) return <section className="set-storage-card"><h2>Brand storage</h2><p role={error ? "alert" : "status"}>{error ? "Couldn’t open workspace storage. Reconnect the workspace and retry." : "Loading storage…"}</p></section>;
  return <QueryClientProvider client={session.client}><HostedStorageUsage endpoint={endpoint} /></QueryClientProvider>;
}
function HostedStorageUsage({ endpoint }: { endpoint: EndpointInfo }) {
  const query = useQuery({ queryKey: managerKeys.storage, staleTime: 60_000, queryFn: async ({ signal }) => {
    const response = await guests.request(endpoint.id, "GET", "/v1/app/files/storage"); signal.throwIfAborted();
    if (!response.available || response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const body = response.body as HostedUsage;
    if (!body || !Array.isArray(body.categories) || !Number.isFinite(Number(body.total_bytes))) throw new Error("Invalid storage response");
    return body;
  } });
  const denied = /HTTP (401|403)|rejected the token/i.test(String(query.error ?? ""));
  const value = denied ? undefined : query.data;
  const labels: Record<string, string> = { image: "Images", video: "Videos", audio: "Audio", other: "Other files" };
  return <section className="set-storage-card"><div className="set-storage-heading"><h2>{value?.scope === "accessible_folders" ? "Accessible media" : "Brand storage"}</h2><button className="linkish" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Updating…" : "Refresh"}</button></div>
    <strong className="set-storage-total">{value ? bytes(value.total_bytes) : "—"}</strong><p className="set-storage-note">Hosted media · {endpoint.name}</p>
    {query.isError && <p role="alert">{denied ? "Storage access is unavailable. Refresh your workspace connection." : String(query.error).includes("404") ? "Hosted storage reporting is awaiting the Boomin API update." : "Couldn’t refresh hosted storage."}{value && " Showing the last measurement."}</p>}
    {query.isPending && <p role="status">Loading storage…</p>}
    {value && <><dl className="set-storage-rows">{value.categories.map((category) => <div key={category.kind}><dt>{labels[category.kind] ?? category.kind} <small>{category.count} files</small></dt><dd>{bytes(category.bytes)}</dd></div>)}</dl><p className="set-storage-note">{value.object_count} stored files · {value.external_file_count} external links excluded.</p>{value.unknown_size_count > 0 && <p className="set-storage-note">{value.unknown_size_count} stored files have no measured size yet.</p>}<p className="set-storage-note">Counts registered media. Preview copies without size tracking are not included yet.</p><p className="set-storage-note">Updated {new Date(value.measured_at).toLocaleString()}</p></>}
  </section>;
}

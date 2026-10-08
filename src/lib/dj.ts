import { invoke } from "@tauri-apps/api/core";
export type DJTrack = {
  id: string;
  path: string;
  title: string;
  artist: string;
  duration_ms: number;
  cover: string | null;
  bpm: number | null;
  analyzed: boolean;
  fingerprint: string;
};
export type DJPlaylist = { id: string; name: string; tracks: string[] };
export type DJLibrary = {
  folder: string;
  tracks: DJTrack[];
  playlists: DJPlaylist[];
};
export type QueueTrack = Pick<DJTrack, "id" | "path" | "title"> & {
  matched_bpm?: number | null;
};
export type DJDeck = {
  track: QueueTrack | null;
  position_ms: number;
  duration_ms: number;
  state: number;
  looping: boolean;
};
export type DJStatus = {
  decks: [DJDeck, DJDeck];
  active: number;
  volume: number;
  crossfader: number;
  fade: number;
  repeat: boolean;
  shuffle: boolean;
  duck: boolean;
  transitioning: boolean;
  error: string | null;
};
export type DJAction =
  | { kind: "status" | "clear" | "pause_all" | "stop_all" }
  | { kind: "queue"; tracks: QueueTrack[] }
  | { kind: "load"; deck: number; track: QueueTrack }
  | { kind: "play"; deck: number; preserve_fader?: boolean }
  | { kind: "pause" | "stop"; deck: number }
  | { kind: "seek"; deck: number; ms: number }
  | { kind: "loop"; deck: number; on: boolean }
  | { kind: "next"; previous: boolean }
  | ({ kind: "mix" } & Pick<
      DJStatus,
      "volume" | "crossfader" | "fade" | "repeat" | "shuffle" | "duck"
    >);
export const dj = {
  library: () => invoke<DJLibrary>("dj_library"),
  import: (paths: string[], folder: string | null = null) =>
    invoke<DJLibrary>("dj_import", { paths, folder }),
  playlist: (playlist: DJPlaylist, remove = false) =>
    invoke<DJLibrary>("dj_save_playlist", { playlist, remove }),
  update: (id: string, bpm: number | null, cover: string | null = null) =>
    invoke<DJLibrary>("dj_update_track", { id, bpm, cover }),
  analyze: (id: string) => invoke<DJLibrary>("dj_analyze", { id }),
  match: (id: string, target: number) =>
    invoke<string>("dj_match_tempo", { id, target }),
  control: (action: DJAction) => invoke<DJStatus>("dj_control", { action }),
};
export const queueTrack = (t: QueueTrack): QueueTrack => ({
  id: t.id,
  path: t.path,
  title: t.title,
});
export function tracklistTracks(lib: DJLibrary, selected: string): DJTrack[] {
  if (!selected) return lib.tracks;
  const ids = lib.playlists.find((p) => p.id === selected)?.tracks ?? [];
  const byId = new Map(lib.tracks.map((t) => [t.id, t]));
  return ids.flatMap((id) => {
    const t = byId.get(id);
    return t ? [t] : [];
  });
}
export function tapBpm(taps: number[]): number | null {
  if (taps.length < 3) return null;
  const gaps = taps
    .slice(1)
    .map((t, i) => t - taps[i])
    .filter((n) => n > 200 && n < 2000)
    .sort((a, b) => a - b);
  return gaps.length < 2
    ? null
    : Math.round((60000 / gaps[Math.floor(gaps.length / 2)]) * 10) / 10;
}

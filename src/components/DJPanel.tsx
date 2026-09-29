import { DJSlider } from "./DJSlider";
import { useEffect, useId, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  dj,
  queueTrack,
  tracklistTracks,
  tapBpm,
  type DJAction,
  type DJLibrary,
  type DJPlaylist,
  type DJStatus,
  type DJTrack,
} from "../lib/dj";
import { notifyError } from "../lib/notices";
import "./DJPanel.css";
function DJIcon({
  name,
}: {
  name:
    | "shuffle"
    | "repeat"
    | "duck"
    | "music"
    | "fade"
    | "folder"
    | "add"
    | "previous"
    | "next"
    | "play"
    | "pause"
    | "stop"
    | "loop"
    | "search";
}) {
  return (
    <svg
      className="dj-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "search" && (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 6 6" />
        </>
      )}
      {name === "previous" && (
        <>
          <path d="M5 5v14" />
          <path d="m19 5-10 7 10 7V5Z" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "next" && (
        <>
          <path d="M19 5v14" />
          <path d="m5 5 10 7-10 7V5Z" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "play" && (
        <path d="m8 4 12 8-12 8V4Z" fill="currentColor" stroke="none" />
      )}
      {name === "pause" && (
        <path
          d="M6 4h4v16H6zM14 4h4v16h-4z"
          fill="currentColor"
          stroke="none"
        />
      )}
      {name === "stop" && (
        <rect
          x="5"
          y="5"
          width="14"
          height="14"
          rx="2"
          fill="currentColor"
          stroke="none"
        />
      )}
      {name === "loop" && <path d="M20 9a8 8 0 1 0 0 7M20 3v6h-6" />}
      {name === "folder" && <path d="M3 7V5h7l2 2h9v13H3V7Z" />}
      {name === "add" && (
        <>
          <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
        </>
      )}
      {name === "shuffle" && (
        <>
          <path d="M3 6h3c5 0 7 12 12 12h3M18 15l3 3-3 3M3 18h3c2 0 3-2 4-4M14 8c1-2 2-2 4-2h3M18 3l3 3-3 3" />
        </>
      )}
      {name === "repeat" && (
        <>
          <path d="m17 2 4 4-4 4M21 6H7a4 4 0 0 0-4 4M7 22l-4-4 4-4M3 18h14a4 4 0 0 0 4-4" />
        </>
      )}
      {name === "duck" && (
        <>
          <rect x="4" y="3" width="6" height="11" rx="3" />
          <path d="M1 10v1a6 6 0 0 0 12 0v-1M7 17v4M4 21h6M19 5v13m-3-3 3 3 3-3" />
        </>
      )}
      {name === "music" && (
        <>
          <path d="M9 18V5l12-2v13M9 8l12-2" />
          <ellipse cx="6" cy="18" rx="3" ry="2" />
          <ellipse cx="18" cy="16" rx="3" ry="2" />
        </>
      )}
      {name === "fade" && (
        <>
          <path d="M3 5v14h18M6 8l12 8" />
          <circle cx="18" cy="16" r="2" />
        </>
      )}
    </svg>
  );
}
const time = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const empty: DJStatus = {
  decks: [
    { track: null, position_ms: 0, duration_ms: 0, state: 5, looping: false },
    { track: null, position_ms: 0, duration_ms: 0, state: 5, looping: false },
  ],
  active: 0,
  volume: 0.65,
  crossfader: 0.5,
  fade: 2,
  repeat: false,
  shuffle: false,
  duck: false,
  transitioning: false,
  error: null,
};
export function DJPanel({
  roomId,
  enabled,
  mini,
}: {
  roomId: string;
  enabled: boolean;
  mini: boolean;
}) {
  const [mixing, setMixing] = useState(
    () => localStorage.getItem(`dj-mode:${roomId}`) === "mix",
  );
  const [library, setLibrary] = useState<DJLibrary | null>(null);
  const [status, setStatus] = useState<DJStatus>(empty);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(
    () => localStorage.getItem(`dj-list:${roomId}`) ?? "",
  );
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchId = useId();
  const [libraryMenu, setLibraryMenu] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!libraryMenu) return;
    menuPanel.current?.querySelector<HTMLSelectElement>("select")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLibraryMenu(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [libraryMenu]);
  const [selectedDeck, setSelectedDeck] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [bpm, setBpm] = useState("");
  const taps = useRef<number[]>([]);
  const mounted = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const report = (e: unknown) => {
    const message = String(e);
    if (mounted.current) setError(message);
    notifyError(message);
  };
  const run = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      report(e);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const control = async (action: DJAction) => {
    const n = ++sequence.current;
    const s = await dj.control(action);
    if (mounted.current && n === sequence.current) setStatus(s);
    return s;
  };
  useEffect(() => {
    dj.library()
      .then((l) => {
        if (mounted.current) setLibrary(l);
      })
      .catch(report);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let dead = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const n = sequence.current;
      try {
        const s = await dj.control({ kind: "status" });
        if (!dead && n === sequence.current) setStatus(s);
      } catch (e) {
        if (!dead) setError(String(e));
      }
      if (!dead) timer = setTimeout(poll, 350);
    };
    void poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [enabled]);
  useEffect(() => {
    if (!library || !enabled) return;
    const list = library.playlists.some((p) => p.id === selected)
      ? selected
      : "";
    if (list !== selected) setSelected(list);
    localStorage.setItem(`dj-list:${roomId}`, list);
    void control({
      kind: "queue",
      tracks: tracklistTracks(library, list).map(queueTrack),
    }).catch(report);
  }, [library, selected, enabled, roomId]);
  const mix = (
    patch: Partial<
      Pick<
        DJStatus,
        "volume" | "crossfader" | "fade" | "repeat" | "shuffle" | "duck"
      >
    >,
  ) => {
    const next = { ...statusRef.current, ...patch };
    statusRef.current = next;
    setStatus(next);
    const settings = {
      volume: next.volume,
      crossfader: next.crossfader,
      fade: next.fade,
      repeat: next.repeat,
      shuffle: next.shuffle,
      duck: next.duck,
    };
    void control({ kind: "mix", ...settings }).catch(report);
    localStorage.setItem(`dj-mix:${roomId}`, JSON.stringify(settings));
  };
  useEffect(() => {
    if (!enabled) return;
    const saved = localStorage.getItem(`dj-mix:${roomId}`);
    if (saved) {
      try {
        const s = JSON.parse(saved);
        void dj
          .control({ kind: "status" })
          .then((current) => {
            if (!mounted.current) return;
            if (current.decks.every((d) => !d.track))
              return control({
                kind: "mix",
                volume: Number(s.volume),
                crossfader: 0.5,
                fade: Number(s.fade),
                repeat: !!s.repeat,
                shuffle: !!s.shuffle,
                duck: !!s.duck,
              });
          })
          .catch(report);
      } catch {}
    }
  }, [enabled, roomId]);
  const tracks = library ? tracklistTracks(library, selected) : [];
  const playlist = library?.playlists.find((p) => p.id === selected);
  const targetDeck = mixing ? (selectedDeck ?? status.active) : status.active;
  const active = status.decks[status.active];
  const activeTrack = library?.tracks.find((t) => t.id === active.track?.id);
  const load = (track: DJTrack, deck: number, play = false) =>
    run(async () => {
      await control({ kind: "load", deck, track: queueTrack(track) });
      if (play) await control({ kind: "play", deck, preserve_fader: mixing });
      if (!track.analyzed && !track.bpm) {
        void dj
          .analyze(track.id)
          .then((l) => {
            if (mounted.current) setLibrary(l);
          })
          .catch(report);
      }
    });
  const transport = (deck: number) => {
    const d = status.decks[deck];
    const playing = d.state === 1 || d.state === 2 || d.state === 3;
    return (
      <div className="dj-transport">
        <button
          aria-label="Previous track"
          title="Previous track"
          disabled={!enabled || busy || !tracks.length || status.transitioning}
          onClick={() =>
            void run(async () => {
              await control({ kind: "next", previous: true });
            })
          }
        >
          <DJIcon name="previous" />
        </button>
        <button
          className="dj-play"
          aria-label={playing ? "Pause" : "Play"}
          disabled={!enabled || busy || (!d.track && !tracks.length)}
          onClick={() =>
            void run(async () => {
              if (!d.track && tracks[0])
                await control({
                  kind: "load",
                  deck,
                  track: queueTrack(tracks[0]),
                });
              if (playing && (mini || !mixing))
                await control({ kind: "pause_all" });
              else
                await control(
                  playing
                    ? { kind: "pause", deck }
                    : { kind: "play", deck, preserve_fader: mixing },
                );
            })
          }
        >
          <DJIcon name={playing ? "pause" : "play"} />
        </button>
        <button
          aria-label="Stop"
          title={`Fade out over ${status.fade}s`}
          disabled={!enabled || !d.track}
          onClick={() =>
            void control(
              mini || !mixing ? { kind: "stop_all" } : { kind: "stop", deck },
            ).catch(report)
          }
        >
          <DJIcon name="stop" />
        </button>
        <button
          aria-label="Next track"
          title="Next track"
          disabled={!enabled || busy || !tracks.length || status.transitioning}
          onClick={() =>
            void run(async () => {
              await control({ kind: "next", previous: false });
            })
          }
        >
          <DJIcon name="next" />
        </button>
      </div>
    );
  };
  const cover = (
    t: DJTrack | undefined,
    editable = false,
    playing = false,
    platter = false,
  ) => (
    <button
      className={`dj-cover${platter ? " dj-platter" : ""}${playing ? " spinning" : ""}`}
      title={editable && t ? "Choose cover photo" : (t?.title ?? "DJ")}
      aria-label={
        editable ? "Choose cover photo" : (t?.title ?? "Track artwork")
      }
      disabled={!editable || !t || busy}
      onClick={() =>
        t &&
        void run(async () => {
          const p = await open({
            multiple: false,
            filters: [
              { name: "Cover", extensions: ["jpg", "jpeg", "png", "webp"] },
            ],
          });
          if (typeof p === "string") setLibrary(await dj.update(t.id, null, p));
        })
      }
    >
      {t?.cover ? <img src={convertFileSrc(t.cover)} alt="" /> : <span>♫</span>}
    </button>
  );
  const savePlaylist = async (p: DJPlaylist) =>
    setLibrary(await dj.playlist(p));
  const reorder = (id: string, delta: number) =>
    playlist &&
    void run(async () => {
      const ids = [...playlist.tracks],
        i = ids.indexOf(id),
        j = i + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await savePlaylist({ ...playlist, tracks: ids });
    });
  if (mini)
    return (
      <div className="dj-mini">
        {cover(activeTrack, false, active.state === 1, true)}
        <div className="dj-mini-track">
          <strong>{active.track?.title ?? "Load a track"}</strong>
          <small>
            {(active.track?.matched_bpm ?? activeTrack?.bpm)
              ? `${(active.track?.matched_bpm ?? activeTrack!.bpm!).toFixed(1)} BPM`
              : "Local music · DJ"}
          </small>
        </div>
        {transport(status.active)}
        <label className="dj-mini-volume" title="Music volume">
          <span>♫</span>
          <DJSlider
            label="Music volume"
            max={1}
            step={0.01}
            value={status.volume}
            live
            disabled={!enabled}
            onValue={(volume) => mix({ volume })}
          />
        </label>
        <div
          className="dj-mini-progress"
          style={{
            width: `${active.duration_ms ? (active.position_ms / active.duration_ms) * 100 : 0}%`,
          }}
        />
      </div>
    );
  return (
    <div className={`dj-panel${mixing ? " mixing" : ""}`} aria-label="DJ">
      <div className="dj-console">
        {mixing && (
          <label
            className="dj-crossfade"
            title="Double-click to center the A–B balance"
            onDoubleClick={() => {
              if (enabled && !status.transitioning) mix({ crossfader: 0.5 });
            }}
          >
            <span>A</span>
            <DJSlider
              label="Crossfader"
              max={1}
              step={0.01}
              value={status.crossfader}
              disabled={!enabled || status.transitioning}
              live
              onValue={(crossfader) => mix({ crossfader })}
            />
            <span>B</span>
          </label>
        )}
        <div className="dj-decks">
          {status.decks.map((d, i) => {
            if (!mixing && i !== status.active) return null;
            const t = library?.tracks.find((t) => t.id === d.track?.id);
            return (
              <div
                key={i}
                className={`dj-deck deck-${i === 0 ? "a" : "b"} ${status.active === i ? "active" : ""} ${targetDeck === i ? "selected" : ""}`}
                onClick={() => setSelectedDeck(i)}
              >
                {t?.cover && (
                  <img
                    className="dj-deck-art"
                    src={convertFileSrc(t.cover)}
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <div className="dj-deck-top">
                  {cover(t, true, d.state === 1, true)}
                  <div className="dj-track-info">
                    <span className="dj-deck-label">
                      <button
                        type="button"
                        className="dj-deck-select"
                        aria-label={`Select deck ${i === 0 ? "A" : "B"}`}
                        aria-pressed={targetDeck === i}
                        onClick={() => setSelectedDeck(i)}
                      >
                        {i === 0 ? "A" : "B"}
                      </button>{" "}
                      {d.state === 1 ? "PLAYING" : d.track ? "READY" : "EMPTY"}
                    </span>
                    <strong title={d.track?.title}>
                      {d.track?.title ?? "Load a track"}
                    </strong>
                    <small>{t?.artist || "Local track"}</small>
                  </div>
                  <button
                    className={`dj-loop ${d.looping ? "on" : ""}`}
                    title="Loop this track"
                    aria-label={`Loop deck ${i === 0 ? "A" : "B"}`}
                    aria-pressed={d.looping}
                    disabled={!d.track || !enabled}
                    onClick={() =>
                      void control({
                        kind: "loop",
                        deck: i,
                        on: !d.looping,
                      }).catch(report)
                    }
                  >
                    <DJIcon name="loop" />
                  </button>
                </div>
                <div className="dj-progress">
                  <DJSlider
                    label={`Seek deck ${i === 0 ? "A" : "B"}`}
                    max={Math.max(1, d.duration_ms)}
                    value={d.position_ms}
                    disabled={!d.duration_ms || !enabled}
                    onValue={(ms) =>
                      void control({ kind: "seek", deck: i, ms }).catch(report)
                    }
                  />
                  <small>
                    {time(d.position_ms)}{" "}
                    <span>{time(d.duration_ms || t?.duration_ms || 0)}</span>
                  </small>
                </div>
                <div className="dj-deck-bottom">
                  {transport(i)}
                  <button
                    className="dj-bpm"
                    title="Detect, edit or tap BPM"
                    disabled={!t || busy}
                    onClick={() => {
                      if (t) {
                        setEditing(t.id);
                        setBpm(t.bpm?.toFixed(1) ?? "");
                        taps.current = [];
                      }
                    }}
                  >
                    {(d.track?.matched_bpm ?? t?.bpm)
                      ? `${(d.track?.matched_bpm ?? t!.bpm!).toFixed(1)} BPM`
                      : "Set BPM"}
                  </button>
                  {i === 1 && d.track && status.decks[0].track && (
                    <button
                      className="dj-match"
                      disabled={
                        busy ||
                        !enabled ||
                        d.state === 1 ||
                        !t?.bpm ||
                        !library?.tracks.find(
                          (t) => t.id === status.decks[0].track?.id,
                        )?.bpm
                      }
                      title="Match B to A without changing pitch. Prepare while B is paused."
                      onClick={() =>
                        void run(async () => {
                          const target =
                            status.decks[0].track?.matched_bpm ??
                            library!.tracks.find(
                              (t) => t.id === status.decks[0].track?.id,
                            )!.bpm!;
                          const path = await dj.match(d.track!.id, target);
                          if (!mounted.current) return;
                          await control({
                            kind: "load",
                            deck: 1,
                            track: { ...d.track!, path, matched_bpm: target },
                          });
                        })
                      }
                    >
                      Sync to A
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <label className="dj-master-volume">
        <DJIcon name="music" />
        <DJSlider
          label="Music volume"
          orientation="vertical"
          max={1}
          step={0.01}
          value={status.volume}
          disabled={!enabled}
          live
          onValue={(volume) => mix({ volume })}
        />
        <small>{Math.round(status.volume * 100)}%</small>
      </label>
      <section className="dj-options dj-options-rail" aria-label="Mixer controls">
        <button
          className={`dj-mix-toggle${mixing ? " on" : ""}`}
          aria-pressed={mixing}
          title="Show two decks and the crossfader"
          onClick={() => {
            setMixing(!mixing);
            mix({ crossfader: mixing ? status.active : 0.5 });
            localStorage.setItem(
              `dj-mode:${roomId}`,
              mixing ? "simple" : "mix",
            );
          }}
        >
          Mix
        </button>
        <label title="Fade duration">
          <select
            aria-label="Fade duration"
            value={status.fade}
            onChange={(e) => mix({ fade: +e.target.value })}
          >
            {[0, 0.5, 1, 2, 4, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
        </label>
        <button
          className={status.shuffle ? "on" : ""}
          aria-pressed={status.shuffle}
          aria-label="Shuffle"
          title="Shuffle tracklist"
          disabled={!enabled}
          onClick={() => mix({ shuffle: !status.shuffle })}
        >
          <DJIcon name="shuffle" />
        </button>
        <button
          className={status.repeat ? "on" : ""}
          aria-pressed={status.repeat}
          aria-label="Repeat"
          title="Repeat tracklist"
          disabled={!enabled}
          onClick={() => mix({ repeat: !status.repeat })}
        >
          <DJIcon name="repeat" />
        </button>
        <button
          className={status.duck ? "on" : ""}
          aria-pressed={status.duck}
          aria-label="Duck mic"
          disabled={!enabled}
          title="Lower music while you speak"
          onClick={() => mix({ duck: !status.duck })}
        >
          <DJIcon name="duck" />
        </button>
      </section>
      <div className="dj-library">
        <div className="dj-library-head">
          {!searchOpen && !libraryMenu && (
            <span className="dj-library-label">{playlist?.name ?? "Tracks"}</span>
          )}
          {searchOpen && !libraryMenu && (
            <div className="dj-library-search">
              <input
                autoFocus
                id={searchId}
                type="search"
                aria-label="Search tracks"
                placeholder="Find a track…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearch("");
                  }
                }}
              />
            </div>
          )}
          {libraryMenu && (
            <div
              ref={menuPanel}
              className="dj-library-menu"
              id={menuId}
              role="region"
              aria-label="Track library options"
            >
              <label>
                <select
                  aria-label="Tracklist"
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setLibraryMenu(false);
                  }}
                >
                  <option value="">All tracks</option>
                  {library?.playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                aria-label="New tracklist"
                title="New tracklist"
                onClick={() => {
                  setLibraryMenu(false);
                  setName("");
                }}
              >
                ＋
              </button>
              <button
                disabled={busy}
                aria-label="Add tracks"
                title="Add local audio files"
                onClick={() => {
                  setLibraryMenu(false);
                  void run(async () => {
                    const p = await open({
                      multiple: true,
                      filters: [
                        {
                          name: "Music",
                          extensions: ["mp3", "m4a", "wav", "flac", "ogg"],
                        },
                      ],
                    });
                    if (p)
                      setLibrary(await dj.import(Array.isArray(p) ? p : [p]));
                  });
                }}
              >
                <DJIcon name="add" />
              </button>
              <button
                disabled={busy}
                aria-label="Choose music folder"
                title={library?.folder || "Choose music folder"}
                onClick={() => {
                  setLibraryMenu(false);
                  void run(async () => {
                    const p = await open({
                      directory: true,
                      multiple: false,
                      defaultPath: library?.folder,
                    });
                    if (typeof p === "string") setLibrary(await dj.import([], p));
                  });
                }}
              >
                <DJIcon name="folder" />
              </button>
              <button
                disabled={busy || !library?.folder}
                title="Rescan music folder"
                aria-label="Rescan folder"
                onClick={() => {
                  setLibraryMenu(false);
                  void run(async () => {
                    setLibrary(await dj.import([], library!.folder));
                  });
                }}
              >
                ↻
              </button>
            </div>
          )}

          <button
            type="button"
            title="Find a track"
            aria-label="Find a track"
            aria-expanded={searchOpen}
            aria-controls={searchId}
            className={searchOpen ? "on" : ""}
            onClick={() => {
              setLibraryMenu(false);
              setSearchOpen(!searchOpen);
              if (searchOpen) setSearch("");
            }}
          >
            <DJIcon name="search" />
          </button>
          <button
            ref={menuButton}
            type="button"
            aria-label="Track library options"
            title="Track library options"
            aria-controls={menuId}
            aria-expanded={libraryMenu}
            className={libraryMenu ? "on" : ""}
            onClick={() => {
              setSearchOpen(false);
              setSearch("");
              setLibraryMenu(!libraryMenu);
            }}
          >
            ⋯
          </button>
        </div>
        {name !== null && (
          <form
            className="dj-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const p = { id: crypto.randomUUID(), name, tracks: [] };
                setLibrary(await dj.playlist(p));
                setSelected(p.id);
                setName(null);
              });
            }}
          >
            <input
              autoFocus
              placeholder="Tracklist name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button disabled={!name.trim() || busy}>Save</button>
            <button type="button" onClick={() => setName(null)}>
              Cancel
            </button>
          </form>
        )}
        <div className="dj-tracklist">
          {playlist && tracks.length === 0 ? (
            <p>Add tracks from your library to this tracklist.</p>
          ) : null}
          {(playlist && tracks.length === 0 ? (library?.tracks ?? []) : tracks)
            .filter((t) =>
              `${t.title} ${t.artist}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((t, n) => (
              <div
                className={`dj-track ${status.decks.some((d) => d.track?.id === t.id) ? "loaded" : ""}`}
                key={t.id}
              >
                {cover(t)}
                <button
                  className="dj-track-title"
                  title={
                    mixing
                      ? `Load into deck ${targetDeck === 0 ? "A" : "B"}`
                      : "Play on the active deck"
                  }
                  disabled={!enabled || busy}
                  onClick={() => void load(t, targetDeck, !mixing)}
                >
                  <strong>{t.title}</strong>
                  <small>
                    {t.bpm ? `${t.bpm.toFixed(1)} BPM · ` : ""}
                    {time(t.duration_ms)}
                    {t.artist ? ` · ${t.artist}` : ""}
                  </small>
                </button>
                <div className="dj-track-actions">
                  <button
                    title="Load into deck A"
                    disabled={!enabled || busy}
                    onClick={() => {
                      setSelectedDeck(0);
                      void load(t, 0);
                    }}
                  >
                    A
                  </button>
                  <button
                    title="Load into deck B"
                    disabled={!enabled || busy}
                    onClick={() => {
                      setSelectedDeck(1);
                      void load(t, 1);
                    }}
                  >
                    B
                  </button>
                  {playlist?.tracks.includes(t.id) && (
                    <>
                      <button
                        aria-label={`Move ${t.title} up`}
                        disabled={n === 0 || busy}
                        onClick={() => reorder(t.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Move ${t.title} down`}
                        disabled={n === tracks.length - 1 || busy}
                        onClick={() => reorder(t.id, 1)}
                      >
                        ↓
                      </button>
                      <button
                        aria-label={`Remove ${t.title} from tracklist`}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await savePlaylist({
                              ...playlist,
                              tracks: playlist.tracks.filter(
                                (id) => id !== t.id,
                              ),
                            });
                          })
                        }
                      >
                        ×
                      </button>
                    </>
                  )}
                  {!playlist && library?.playlists.length ? (
                    <select
                      aria-label={`Add ${t.title} to tracklist`}
                      value=""
                      onChange={(e) => {
                        const p = library.playlists.find(
                          (p) => p.id === e.target.value,
                        );
                        if (p && !p.tracks.includes(t.id))
                          void run(async () => {
                            await savePlaylist({
                              ...p,
                              tracks: [...p.tracks, t.id],
                            });
                          });
                      }}
                    >
                      <option value="">＋</option>
                      {library.playlists.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {playlist && !playlist.tracks.includes(t.id) && (
                    <button
                      title="Add to tracklist"
                      onClick={() =>
                        void run(async () => {
                          await savePlaylist({
                            ...playlist,
                            tracks: [...playlist.tracks, t.id],
                          });
                        })
                      }
                    >
                      ＋
                    </button>
                  )}
                </div>
              </div>
            ))}
          {library && library.tracks.length === 0 && (
            <div className="dj-empty">
              <span>♫</span>
              <strong>Your tracks, in the room.</strong>
              <p>Add audio files or choose your music folder.</p>
              <small>{library.folder}</small>
            </div>
          )}
          {!library && <p>Opening your library…</p>}
        </div>
        {playlist && tracks.length > 0 && (
          <button
            className="dj-add-from-library"
            onClick={() => setSelected("")}
          >
            Add more from library
          </button>
        )}
      </div>
      {editing && (
        <form
          className="dj-bpm-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setLibrary(await dj.update(editing, +bpm));
              setEditing(null);
            });
          }}
        >
          <strong>
            BPM · {library?.tracks.find((t) => t.id === editing)?.title}
          </strong>
          <div>
            <input
              type="number"
              min="30"
              max="300"
              step=".1"
              aria-label="Track BPM"
              value={bpm}
              onChange={(e) => setBpm(e.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const now = performance.now();
                if (now - (taps.current[taps.current.length - 1] ?? 0) > 2000)
                  taps.current = [];
                taps.current = [...taps.current.slice(-7), now];
                const n = tapBpm(taps.current);
                if (n) setBpm(String(n));
              }}
            >
              Tap
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const l = await dj.analyze(editing);
                  setLibrary(l);
                  setBpm(
                    l.tracks.find((t) => t.id === editing)?.bpm?.toFixed(1) ??
                      "",
                  );
                })
              }
            >
              Detect
            </button>
            <button disabled={busy || !bpm}>Save</button>
            <button type="button" onClick={() => setEditing(null)}>
              ×
            </button>
          </div>
          <small>
            Detected BPM is an estimate. Tap or correct it for your track.
          </small>
        </form>
      )}
      {busy && (
        <div className="dj-status" role="status">
          Preparing your music…
        </div>
      )}
      {(error || status.error) && (
        <div className="dj-error" role="alert">
          {error || status.error}
        </div>
      )}
      {!enabled && (
        <div className="dj-status">
          The host controls DJ once the room is ready.
        </div>
      )}
    </div>
  );
}

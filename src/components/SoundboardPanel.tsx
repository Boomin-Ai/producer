import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { sounds, soundHotkeysEnabled, type SoundBoard, type SoundLibrary, type SoundPad, type SoundStatus } from '../lib/soundboard';
import './SoundboardPanel.css';

export function SoundboardPanel({ roomId, enabled, compact = false }: { roomId: string; enabled: boolean; compact?: boolean }) {
  const [library, setLibrary] = useState<SoundLibrary | null>(null);
  const [status, setStatus] = useState<SoundStatus | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkeys, setHotkeys] = useState(soundHotkeysEnabled);
  const [pair, setPair] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const sequence = useRef(0);
  const saving = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const pending = saving.current;
      try {
        await pending;
        const next = await sounds.library(roomId);
        if (active && saving.current === pending) setLibrary(next);
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void refresh();
    window.addEventListener('producer:soundboard-library', refresh);
    return () => {
      active = false;
      window.removeEventListener('producer:soundboard-library', refresh);
    };
  }, [roomId]);

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const n = sequence.current;
      try {
        const next = await sounds.control(roomId, 'status');
        if (!dead && n === sequence.current) {
          setStatus(next);
          setError(previous => previous.includes('room is not active') ? '' : previous);
        }
      } catch (e) {
        if (!dead && n === sequence.current) setError(String(e));
      }
      if (!dead) timer = setTimeout(poll, 300);
    };
    void poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [roomId, enabled]);

  useEffect(() => {
    if (!settingsOpen || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => {
      element.close();
      const trigger = returnFocus.current;
      (trigger?.isConnected ? trigger : settingsButton.current)?.focus();
    };
  }, [settingsOpen]);

  const openSettings = (event: MouseEvent<HTMLButtonElement>, soundId: string | null = null) => {
    returnFocus.current = event.currentTarget;
    setSearch('');
    setEdit(soundId);
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setPair('');
  };

  const run = async (action: string, id = '') => {
    const n = ++sequence.current;
    setError('');
    try {
      const next = await sounds.control(roomId, action, id);
      if (n === sequence.current) setStatus(next);
    } catch (e) {
      if (n === sequence.current) setError(String(e));
    }
  };

  const save = (board: SoundBoard) => {
    setLibrary(previous => previous && { ...previous, board });
    saving.current = saving.current.then(async () => {
      try {
        await sounds.save(roomId, board);
      } catch (e) {
        setError(String(e));
      }
    });
  };

  const trigger = async (action: 'play' | 'preview', id: string) => {
    // A pad can appear in the dock before its assignment has reached the native store.
    await saving.current;
    await run(action, id);
  };

  const importing = async (folder: boolean) => {
    setBusy(true);
    setError('');
    try {
      const paths = await open({
        directory: folder,
        multiple: !folder,
        filters: folder ? undefined : [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg'] }],
      });
      if (!paths) return;
      await saving.current;
      const next = await sounds.import(roomId, Array.isArray(paths) ? paths : [paths]);
      setLibrary(next);
      if (enabled) await sounds.activate(roomId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pads = library?.board.pads ?? [];
  const connected = new Set(pads.map(pad => pad.id));
  const editing = pads.find(pad => pad.id === edit);
  const inventory = settingsOpen
    ? library?.sounds.filter(sound => sound.name.toLowerCase().includes(search.trim().toLowerCase())) ?? []
    : [];
  const playing = status?.playing ?? [];
  const previewing = status?.previewing ?? [];

  const updateBoard = (change: Partial<SoundBoard>) => {
    if (library) save({ ...library.board, ...change });
  };

  const patch = (change: Partial<SoundPad>) => {
    updateBoard({ pads: pads.map(pad => pad.id === edit ? { ...pad, ...change } : pad) });
  };

  const removeFromRoom = (id: string) => {
    if (enabled) {
      // Stop needs the pad to remain on the native board until the command runs.
      saving.current = saving.current.then(() => run('stop', id));
    }
    updateBoard({ pads: pads.filter(pad => pad.id !== id) });
    if (editing?.id === id) setEdit(null);
  };

  return <div className={`sb-panel${compact ? ' sb-panel--compact' : ''}`}>
    <div className="sb-toolbar">
      <strong>Room sounds</strong>
      <button ref={settingsButton} className="sb-settings-trigger" aria-label="Sound settings" title="Sound settings"
        aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={event => openSettings(event)}>
        {compact ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2 4h4m3 0h5M2 8h8m3 0h1M2 12h1m3 0h8M7 2v4m4 0v4M4 10v4"/>
        </svg> : 'Sound settings'}
      </button>
      {(playing.length > 0 || previewing.length > 0) &&
        <button className="sb-stop" aria-label="Stop all" title="Stop all" disabled={!enabled}
          onClick={() => void run('stop_all')}>{compact ? '■' : '■ Stop all'}</button>}
    </div>
    {error && !settingsOpen && <p className="sb-error" title={error} role="alert">{error}</p>}
    {pads.length > 0 && <ul className="sb-pads" aria-label="Connected sounds">
      {pads.map(pad => {
        const active = playing.includes(pad.id);
        const preview = previewing.includes(pad.id);
        return <li className={`sb-pad${active ? ' is-playing' : ''}`} key={pad.id} style={{ '--sound-color': pad.color } as CSSProperties}>
          <button className="sb-trigger" aria-pressed={active} disabled={!enabled} title={pad.name}
            onClick={() => void trigger('play', pad.id)}
            onPointerEnter={() => { if (enabled) void sounds.control(roomId, 'prepare', pad.id).catch(() => {}); }}>
            <span className="sb-indicator" aria-hidden="true">{active ? '◼' : '▶'}</span>
            <strong>{pad.name}</strong>
          </button>
          {!compact && <><button disabled={!enabled} aria-label={`Preview ${pad.name}`} title="Preview in headphones"
            aria-pressed={preview} onClick={() => void trigger('preview', pad.id)}>Preview</button>
          <button aria-label={`Edit ${pad.name}`} onClick={event => openSettings(event, pad.id)}>Edit</button>
          {(active || preview) && <button disabled={!enabled} aria-label={`Stop ${pad.name}`} onClick={() => void run('stop', pad.id)}>■</button>}</>}
        </li>;
      })}
    </ul>}
    {library && !pads.length && (compact ? <button className="sb-compact-empty" aria-haspopup="dialog" onClick={event => openSettings(event)}>Add sounds</button> : <div className="sb-empty">
      <strong>No sounds connected</strong>
      <p>Choose the sounds you want to play in this room.</p>
      <button aria-haspopup="dialog" onClick={event => openSettings(event)}>Browse sound library</button>
    </div>)}

    {settingsOpen && createPortal(<dialog ref={dialog} className="sb-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); closeSettings(); }}
      onClick={event => { if (event.target === event.currentTarget) closeSettings(); }}>
      <div className="sb-dialog-content">
        <header className="sb-dialog-header">
          <div><h2 id={titleId}>Sound settings</h2><p>Manage the library and choose what appears in this room.</p></div>
          <button autoFocus onClick={closeSettings}>Done</button>
        </header>
        {error && <p className="sb-error" role="alert">{error}</p>}
        <div className="sb-settings-layout">
          <section className="sb-settings" aria-label="Sound library">
            <div className="sb-toolbar">
              <h3>Sound library</h3>
              <span>{pads.length} connected</span>
            </div>
            <div className="sb-toolbar">
              <button disabled={busy || !library} onClick={() => void importing(false)}>Import sounds</button>
              <button disabled={busy || !library} onClick={() => void importing(true)}>Import folder</button>
            </div>
            <p>Imports are saved to the library and connected to this room.</p>
            {busy && <p role="status">Importing sounds…</p>}
            <input type="search" aria-label="Search sound library" placeholder="Search library" value={search} onChange={event => setSearch(event.target.value)} />
            <ul className="sb-inventory">
              {inventory.map(sound => {
                const assigned = connected.has(sound.id);
                return <li key={sound.id}>
                  <span title={sound.name}>{sound.name}</span>
                  {assigned && compact && <button aria-label={`Edit ${sound.name}`} onClick={() => setEdit(sound.id)}>Edit</button>}
                  <button className={assigned ? undefined : 'sb-connect'} disabled={busy || (!assigned && pads.length >= 500)}
                    aria-label={assigned ? `Remove ${sound.name} from room` : `Connect ${sound.name} to room`}
                    onClick={() => {
                      if (assigned) {
                        removeFromRoom(sound.id);
                        return;
                      }
                      const pad: SoundPad = { id: sound.id, name: sound.name, color: '#36DFFF', mode: 'restart', volume: .8, fade_ms: 5 };
                      updateBoard({ pads: [...pads, pad] });
                    }}>{assigned ? 'Remove' : 'Connect'}</button>
                </li>;
              })}
            </ul>
            {library && !inventory.length && <p>{library.sounds.length ? 'No sounds match your search.' : 'Import sounds to start your library.'}</p>}
          </section>
          <div className="sb-settings-side">
            {editing && <section className="sb-settings" aria-label="Edit sound">
              <h3>Edit sound</h3>
              <label>Name<input disabled={busy} value={editing.name} onChange={event => patch({ name: event.target.value })} /></label>
              <label>Playback<select aria-label="Playback" disabled={busy} value={editing.mode} onChange={event => patch({ mode: event.target.value as SoundPad['mode'] })}>
                <option value="restart">Restart on press</option><option value="toggle">Play / stop</option>
                <option value="overlap">Overlap</option><option value="loop">Loop / stop</option>
              </select></label>
              <label>Level<input disabled={busy} type="range" min="0" max="1" step=".01" value={editing.volume} onChange={event => patch({ volume: Number(event.target.value) })} /></label>
              <label>Fade (ms)<input disabled={busy} type="number" min="0" max="5000" value={editing.fade_ms} onChange={event => patch({ fade_ms: Math.max(0, Math.min(5000, Number(event.target.value))) })} /></label>
              <label>Color<input disabled={busy} type="color" value={editing.color} onChange={event => patch({ color: event.target.value })} /></label>
              <div className="sb-toolbar">
                <button disabled={busy || pads[0]?.id === editing.id} onClick={() => updateBoard({ pads: [editing, ...pads.filter(pad => pad.id !== editing.id)] })}>Move to first pad</button>
                <button disabled={busy} onClick={() => removeFromRoom(editing.id)}>Remove from room</button>
              </div>
            </section>}
            <section className="sb-settings" aria-label="Room playback">
              <h3>Room playback</h3>
              <label>Effects volume <input type="range" min="0" max="1" step=".01"
                value={library?.board.volume ?? .8} disabled={!library || busy} onChange={event => updateBoard({ volume: Number(event.target.value) })} /></label>
              <label><input type="checkbox" checked={library?.board.monitor ?? true} disabled={!library || busy}
                onChange={event => updateBoard({ monitor: event.target.checked })} /> Hear effects</label>
            </section>
            <details className="sb-settings sb-controllers">
              <summary>Stream Deck and shortcuts</summary>
              <p>Install the Producer Sounds plugin and paste this connection into its settings.</p>
              <div className="sb-toolbar">
                <button onClick={() => void sounds.pairing().then(value => setPair(JSON.stringify(value))).catch(e => setError(String(e)))}>Show pairing connection</button>
                {pair && <button onClick={() => void navigator.clipboard.writeText(pair).catch(() => setError('Select and copy the connection field.'))}>Copy connection</button>}
              </div>
              {pair && <input aria-label="Pairing connection" readOnly type="password" value={pair} onFocus={event => event.target.select()} />}
              <label><input type="checkbox" checked={hotkeys} onChange={event => {
                const enabled = event.target.checked;
                void sounds.hotkeys(enabled).then(() => setHotkeys(enabled)).catch(e => setError(String(e)));
              }} /> Global keyboard shortcuts</label>
              <p>Ctrl + Alt + Shift + 1–9 plays the first nine pads. 0 stops all. On Mac, Alt is Option.</p>
            </details>
          </div>
        </div>
      </div>
    </dialog>, document.body)}
  </div>;
}

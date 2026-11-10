import { useEffect, useRef, useState } from 'react';
import type { CameraBackground, CameraBackgroundControls as Controls } from '../../lib/cameraBackground';

export function CameraBackgroundControls({ slot, source, label, controls, disabled = false }: {
  slot: string; source: string; label: string; controls: Controls; disabled?: boolean;
}) {
  const [mode, setMode] = useState<CameraBackground>();
  const [retryMode, setRetryMode] = useState<'framed' | 'cutout'>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  const load = async (requested?: 'framed' | 'cutout') => {
    const ticket = ++generation.current;
    setBusy(true); setError('');
    try {
      const receipt = await (requested ? controls.set(slot, source, requested) : controls.read(slot, source));
      if (ticket === generation.current) { setMode(receipt); setRetryMode(undefined); }
    } catch (cause) {
      if (ticket === generation.current) { setMode(undefined); setRetryMode(requested); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (ticket === generation.current) setBusy(false); }
  };
  useEffect(() => {
    setMode(undefined); setRetryMode(undefined); setError('');
    if (!disabled) void load();
    const unsubscribe = controls.subscribe(changed => { if (!disabled && changed === source) void load(); });
    return () => { ++generation.current; unsubscribe(); };
  }, [slot, source, controls, disabled]);
  return <fieldset className="set-camera-background" disabled={disabled || busy} aria-label={`${label} background`}>
    <legend>{label} background</legend>
    <div>
      <button type="button" aria-label={`${label} Framed`} aria-pressed={mode === 'framed'} title="Show the camera with Cutout off" onClick={() => void load('framed')}>Framed</button>
      <button type="button" aria-label={`${label} Cutout`} aria-pressed={mode === 'cutout'} onClick={() => void load('cutout')}>Cutout</button>
      {busy && <span role="status">Updating background…</span>}
      {!busy && mode === 'soft' && <span role="status">Soft background</span>}
    </div>
    <small>Applies wherever this camera is used.</small>
    {error && <p role="alert" className="set-error">{error} <button type="button" onClick={() => void load(retryMode)}>{retryMode ? 'Retry applying/saving' : 'Check camera'}</button></p>}
  </fieldset>;
}

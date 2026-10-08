import {invoke} from '@tauri-apps/api/core';
import {AssetTransport} from './assetTransport';
import { useEffect, useRef, useState } from 'react';
import lottie from './vendor/lottie-light.js?raw';
import frame from './frame.js?raw';
import shaderKernel from './shader-kernel.glsl?raw';
import shaderPreview from './shader-preview.js?raw';
import { outputProjection } from './projection';
import type { RehearsalState } from './rehearsal';
import type { PresentationPackage } from './schema';

export function SetPreview({ doc, state }: { doc: PresentationPackage; state: RehearsalState }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const latest = useRef({ doc, state }); latest.current = { doc, state };
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const source = useRef('');
  if (!source.current) {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    source.current = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: http://127.0.0.1:*; media-src data: http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#100f15;font-family:system-ui,sans-serif}*{box-sizing:border-box}#canvas{position:absolute;transform-origin:top left;overflow:hidden}div.slot{display:flex;align-items:center;justify-content:center;color:#b6aebd;font-size:20px}</style><style id="motion"></style></head><body><div id="canvas"></div><script nonce="${nonce}">const PRODUCER_SHADER_KERNEL=${JSON.stringify(shaderKernel)};\n${shaderPreview}\n${lottie}\n${frame}</script></body></html>`;
  }
  const media=useRef(new AssetTransport());
  const sequence=useRef(0),localUrls=useRef(new Map<string,Promise<string>>());
  const send = async () => {
    const ticket=++sequence.current;
    if (!port.current) return;
    try {const projection=outputProjection(latest.current.doc,latest.current.state);
      for(const [id,a] of Object.entries(projection.assets??{})){if(a.data.startsWith('producer-media:')){let url=localUrls.current.get(a.data);if(!url){url=invoke<string>('set_media_resolve',{id:a.data});localUrls.current.set(a.data,url);}try{projection.assets![id]={...a,data:await url};}catch(e){localUrls.current.delete(a.data);throw e;}}}
      if(ticket!==sequence.current||!port.current)return;port.current.postMessage({type:'output',projection:media.current.compact(projection),assetIds:Object.keys(latest.current.doc.set.assets??{})});media.current.acknowledge(projection);setError('');}
    catch (e) { setError(e instanceof Error ? e.message : 'Preview unavailable.'); }
  };
  useEffect(() => {
    const timeout = window.setTimeout(() => setError('Preview did not connect. Reset or reload rehearsal.'), 5000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || e.data !== 'presentation.ready' || port.current) return;
      media.current.clear();const channel = new MessageChannel(); port.current = channel.port1;
      channel.port1.onmessage = event => {
        if (event.data?.type === 'connected') { window.clearTimeout(timeout); setReady(true); send(); }
        if (event.data?.type === 'error') setError('Preview renderer failed. Stop or reset rehearsal.');
      };
      channel.port1.start(); e.source?.postMessage('presentation.connect', { targetOrigin: '*', transfer: [channel.port2] });
    };
    window.addEventListener('message', onMessage);
    // Probe on setup and load: handles both fast srcdoc startup and React's
    // development effect teardown/reconnect without retaining a closed port.
    ref.current?.contentWindow?.postMessage('presentation.probe', '*');
    return () => { window.clearTimeout(timeout); window.removeEventListener('message', onMessage); port.current?.close(); port.current = null; };
  }, []);
  useEffect(()=>{void send();}, [doc, state]);
  const layout = doc.set.layouts.find(l => l.id === state.layoutId)!;
  const previewMode = state.workspaceMode === 'prepare' ? 'set' : 'rehearsal';
  return <div className="set-preview" style={{ aspectRatio: `${layout.width}/${layout.height}` }} aria-label={`${previewMode === 'set' ? 'Set' : 'Rehearsal'} output preview`}>
    <iframe ref={ref} title={`${doc.name} ${previewMode} output`} sandbox="allow-scripts" srcDoc={source.current}
      onLoad={() => ref.current?.contentWindow?.postMessage('presentation.probe', '*')} />
    {!ready && <span className="set-preview-status">Opening preview…</span>}
    {error && <span role="alert" className="set-preview-status">{error}</span>}
  </div>;
}

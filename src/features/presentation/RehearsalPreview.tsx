import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SetPreview } from './SetPreview';
import type { PresentationPackage } from './schema';
import type { RehearsalState } from './rehearsal';

function PreviewDialog({ doc, state, onClose, returnFocus, editor, sources, outputActive }: {
  editor?:ReactNode; sources?:ReactNode; outputActive?:boolean; doc: PresentationPackage; state: RehearsalState; onClose: () => void; returnFocus: HTMLButtonElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); returnFocus?.focus(); };
  }, [returnFocus]);
  const layout = doc.set.layouts.find(l => l.id === state.layoutId)!;
  const previewMode = state.workspaceMode === 'prepare' ? 'set' : 'rehearsal';
  return createPortal(<dialog ref={dialog} className="set-preview-dialog" aria-label={`${doc.name} ${previewMode} preview`}
    onCancel={onClose} onKeyDown={event=>{
      if(event.key!=='Tab')return;
      const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(el=>el.getClientRects().length>0);
      const current=controls.indexOf(document.activeElement as HTMLElement);
      if(controls.length){event.preventDefault();controls[(current+(event.shiftKey?-1:1)+controls.length)%controls.length]?.focus();}
    }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="set-preview-dialog-content">
      <header><div><strong>{doc.name}</strong><span>{previewMode === 'set' ? 'Set preview' : 'Rehearsal preview'} · {outputActive ? 'Changes update room output' : 'Preview only'}</span></div>
        <button autoFocus onClick={onClose}>Close preview</button></header>
      <div className={`set-editor-layout${editor ? ' has-controls' : ''}`}><div className="set-preview-dialog-canvas" style={{ maxWidth: `min(100%, calc((100dvh - 340px) * ${layout.width / layout.height}))` }}>
        <SetPreview key={state.sandboxId} doc={doc} state={state} />
      </div>{editor && <aside className="set-controls set-editor-controls" aria-label="Edit set">{editor}</aside>}</div>
      {sources && <section className="set-controls set-editor-source-tray" aria-label="Edit source assignments">{sources}</section>}
    </div>
  </dialog>, document.body);
}

export function RehearsalPreview({ doc, state, editor, sources, outputActive }: { editor?:ReactNode; sources?:ReactNode; outputActive?:boolean; doc: PresentationPackage; state: RehearsalState }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(()=>{const open=()=>setExpanded(true);window.addEventListener('producer:edit-set',open);return()=>window.removeEventListener('producer:edit-set',open);},[]);
  const expandButton = useRef<HTMLButtonElement>(null);
  return <div className="set-visual">
    <div className="set-preview-tools">
      <button ref={expandButton} aria-haspopup="dialog" aria-expanded={expanded} onClick={() => setExpanded(true)}>{editor ? 'Set edit' : 'Set preview ↗'}</button>
    </div>
    {expanded && <PreviewDialog doc={doc} state={state} editor={editor} sources={sources} outputActive={outputActive} returnFocus={expandButton.current} onClose={() => setExpanded(false)} />}
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SetPreview } from './SetPreview';
import type { PresentationPackage } from './schema';
import type { RehearsalState } from './rehearsal';

function PreviewDialog({ doc, state, onClose, returnFocus }: {
  doc: PresentationPackage; state: RehearsalState; onClose: () => void; returnFocus: HTMLButtonElement | null;
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
    onKeyDown={event => {
      // Output is read-only: Close is the dialog's only interactive control.
      if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector('button')?.focus(); }
    }}
    onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="set-preview-dialog-content">
      <header><div><strong>{doc.name}</strong><span>{previewMode === 'set' ? 'Set preview' : 'Rehearsal preview'} · Room output unchanged</span></div>
        <button autoFocus onClick={onClose}>Close preview</button></header>
      <div className="set-preview-dialog-canvas" style={{ maxWidth: `min(100%, calc((100vh - 140px) * ${layout.width / layout.height}))` }}>
        <SetPreview key={state.sandboxId} doc={doc} state={state} />
      </div>
    </div>
  </dialog>, document.body);
}

export function RehearsalPreview({ doc, state }: { doc: PresentationPackage; state: RehearsalState }) {
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  return <div className="set-visual">
    <div className="set-preview-tools">
      <button ref={expandButton} aria-haspopup="dialog" aria-expanded={expanded} onClick={() => setExpanded(true)}>Set preview ↗</button>
    </div>
    {expanded && <PreviewDialog doc={doc} state={state} returnFocus={expandButton.current} onClose={() => setExpanded(false)} />}
  </div>;
}

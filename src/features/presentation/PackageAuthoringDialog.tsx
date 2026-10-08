import {PACKAGE_BYTES} from './assets';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../../lib/roomLink';
import { parsePackage, presentationJsonSchema, type PresentationPackage } from './schema';

export type AuthoringIntent = 'edit-set' | 'add-show' | 'export';
const titles: Record<AuthoringIntent, string> = {
  'edit-set': 'Edit set with agent', 'add-show': 'Add show', export: 'Export set package',
};

export function PackageAuthoringDialog({ doc, intent, onLoad, onClose, returnFocus }: {
  doc: PresentationPackage; intent: AuthoringIntent; onLoad: (doc: PresentationPackage) => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState('');
  const [candidate, setCandidate] = useState('');
  const [notice, setNotice] = useState('');
  const packageJson = JSON.stringify(doc, null, 2);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); returnFocus?.focus(); };
  }, [returnFocus]);
  const brief = () => [
    `Update this Producer set package: ${doc.name}. Task: ${titles[intent]}.`,
    request.trim() || (intent === 'add-show' ? 'Attach a show with a clear segment sequence using the supported schema. Keep the existing set design.' : 'Preserve the existing design and show unless my requested change requires it.'),
    'Return a complete JSON package only, within 40 MB (including embedded assets). Keep stable source slot IDs and preserve configured fields unless instructed otherwise.',
    'The set is independent of its optional show. Never add dummy contestants or votes to a standalone set. This prototype show module supports the declared voting fixture; do not invent unsupported actions or pretend other formats are executable.',
    'Use only the schema below. No scripts, HTML, URLs, credentials, camera/microphone activation, recording or streaming commands. Producer owns Stop and recovery. The updated package will be validated and rehearsed before live integration.',
    'GPU effects use shader nodes with aurora, edgeGlow, lightSweep, plasma, silk, rings, grid, stars, petals, contours, prism, or borderFlare presets. Put up to four shader nodes directly under a relative layout root whose numeric width/height match the canvas; root styles are position, width, height, background and overflow only. Shader nodes use numeric absolute left/top/width/height, three #RRGGBB colors, speed 0–4, intensity 0–2, scale 0.25–4, opacity 0–1, radius 0–960, quality low/medium, and clock show/segment. Shader planes sit above the root background and below cameras and foreground graphics; reserve a padded rectangle around a camera for edgeGlow. Use shader.intensity or shader.scale keyframe tracks to animate parameters. No imported shader code. Author separate landscape and portrait layouts.',
    'Configured package (no rehearsal results or participant identities):', packageJson,
    'JSON Schema (Producer also checks cross-references, bindings and expansion limits):', JSON.stringify(presentationJsonSchema),
  ].join('\n\n');
  async function copy(text: string, label: string) {
    setNotice(await copyText(text) ? `${label} copied.` : 'Copy failed. Select the JSON below and copy it manually.');
  }
  function load() {
    try {
      if (new TextEncoder().encode(candidate).length > PACKAGE_BYTES) throw new Error('Set package exceeds 40 MB.');
      const next = parsePackage(JSON.parse(candidate));
      if (intent === 'add-show' && !next.show) throw new Error('This package has no show attached. Ask your agent to include its show module.');
      onLoad(next); onClose();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Unable to load package.'); }
  }
  return createPortal(<dialog ref={ref} className="set-authoring-dialog" aria-label={titles[intent]}
    onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <header><div><strong>{titles[intent]}</strong><span>{doc.name} · Agent authoring</span></div><button onClick={onClose}>Close</button></header>
    <p>Edit everyday values in Setup. For design or show rules, give your agent this package and brief, then import its updated JSON. Loading replaces this prepared package and exits rehearsal; room output stays unchanged.</p>
    {intent !== 'export' && <label>Changes to request<textarea autoFocus value={request} onChange={e => setRequest(e.target.value)} placeholder={intent === 'add-show' ? 'Describe the segments, timing and interactions you want…' : 'Describe the design or show changes you want…'} maxLength={4000} /></label>}
    <div className="set-authoring-actions"><button onClick={() => void copy(packageJson, 'Package JSON')}>Copy package JSON</button>
      <button onClick={() => void copy(brief(), 'Agent brief')}>Copy agent brief</button></div>
    <details><summary>Configured package JSON</summary><textarea aria-label="Configured package JSON" value={packageJson} readOnly /></details>
    {intent !== 'export' && <label>Updated package JSON<textarea aria-label="Updated package JSON" value={candidate} onChange={e => setCandidate(e.target.value)} placeholder="Paste the complete JSON returned by your agent, or use Import JSON in Set settings." /></label>}
    {notice && <p role="status">{notice}</p>}
    <footer><span>Validate → Load preparation → Rehearse</span>{intent !== 'export' && <button disabled={!candidate.trim()} onClick={load}>Validate and load</button>}</footer>
  </dialog>, document.body);
}

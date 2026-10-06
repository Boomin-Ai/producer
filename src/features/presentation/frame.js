/* Trusted minimal renderer. This file is bundled as inert text into a sandboxed
 * opaque-origin frame. Imported packages never supply JavaScript or HTML. */
(() => {
  const canvas = document.getElementById('canvas');
  const style = document.getElementById('motion');
  let width = 1280, height = 720, port, sequence = 0;
  const entries = new Map();
  const px = new Set(['inset','left','top','right','bottom','width','height','gap','padding','fontSize','borderRadius','minHeight','maxWidth']);
  function fit() {
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    canvas.style.transform = 'scale(' + Math.min(innerWidth / width, innerHeight / height) + ')';
  }
  function sync(node, parent, used, surface, isRoot = false) {
    used.add(node.id);
    let entry = entries.get(node.id);
    if (!entry || entry.type !== node.type) {
      if (entry) entry.element.remove();
      const el = document.createElement('div');
      el.dataset.node = node.id; entry = { element: el, type: node.type }; entries.set(node.id, entry);
    }
    const el = entry.element;
    entry.appearance = node.appearance; entry.framing=node.framing;
    el.removeAttribute('style');
    for (const [key, value] of Object.entries(node.styles)) el.style[key] = typeof value === 'number' && px.has(key) ? value + 'px' : String(value);
    // Experimental two-layer native proof: root backdrop below media, remaining
    // graphics above it. General interleaved layers/masks are not implemented.
    if (surface === 'foreground' && isRoot) el.style.background = 'transparent';
    if (surface === 'background' && !isRoot) el.style.visibility = 'hidden';
    el.className = [node.type === 'slot' ? 'slot' : '', node.motionClass || ''].filter(Boolean).join(' ');
    if (node.type === 'text') el.textContent = node.text;
    if (node.type === 'slot') {
      el.dataset.slot = node.slotId;
      el.textContent = '';
      el.setAttribute('aria-label', node.slotLabel + (surface === 'preview' ? ' simulated source' : ' source slot'));
      el.style.background = 'transparent';
      entry.previewShape = null;
      if (node.appearance && surface === 'preview') {
        const a = node.appearance;
        // Keep the placement box unchanged. A circle is inscribed in that box,
        // matching the native mask rather than stretching into an ellipse.
        if (!el.style.position) el.style.position = 'relative';
        const shape = document.createElement('div');
        shape.style.cssText = 'position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;';
        shape.style.borderRadius = a.shape === 'circle' ? '50%' : a.cornerRadius + 'px';
        shape.style.border = a.outlineWidth + 'px solid ' + a.outlineColor;
        shape.style.opacity = a.opacity;
        const fill = document.createElement('div');
        fill.style.cssText = 'position:absolute;inset:0;background:linear-gradient(135deg,#292738,#403748);';
        fill.style.filter = 'grayscale(' + a.grayscale + ')';
        const label = document.createElement('span');
        label.style.position = 'relative';
        label.textContent = node.slotLabel + ' · simulated source';
        shape.append(fill, label); el.appendChild(shape); entry.previewShape = shape;
        if (a.shape === 'circle') {
          shape.style.left = '50%'; shape.style.top = '50%'; shape.style.transform = 'translate(-50%,-50%)';
        } else shape.style.inset = '0';
      }
    }
    if (el.parentNode !== parent) parent.appendChild(el);
    // append also establishes declared order when an existing keyed child moves.
    for (const child of node.children) { sync(child, el, used, surface); el.appendChild(entries.get(child.id).element); }
  }
  addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data === 'presentation.probe') { parent.postMessage('presentation.ready', '*'); return; }
    if (event.data !== 'presentation.connect' || event.ports.length !== 1) return;
    if (port) port.close();
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (!data || data.type !== 'output' || !data.projection) return;
      try {
        const p = data.projection; width = p.width; height = p.height;
        const surface = ['background', 'foreground'].includes(data.surface) ? data.surface : 'preview';
        const ticket = ++sequence;
        const used = new Set(); sync(p.root, canvas, used, surface, true);
        for (const [id, entry] of entries) if (!used.has(id)) { entry.element.remove(); entries.delete(id); }
        if (style.textContent !== p.css) style.textContent = p.css;
        fit(); port.postMessage({ type: 'rendered', revision: p.revision });
        // Geometry is a preparation receipt, not proof that OBS has presented
        // this revision. Native readback must still verify its own pixels.
        let acknowledged=false;
        const prepare=()=> {
          if(acknowledged)return;
          if (ticket !== sequence || !port) return;
          const bounds = canvas.getBoundingClientRect(), scale = bounds.width / width;
          if (!(scale > 0)) return;
          for (const e of entries.values()) if (e.previewShape && e.appearance.shape === 'circle') {
            const r = e.element.getBoundingClientRect();
            const size = Math.min(r.width, r.height) / scale;
            e.previewShape.style.width = size + 'px'; e.previewShape.style.height = size + 'px';
          }
          const slots = [...entries.values()].filter(e => e.type === 'slot').map(e => {
            const r = e.element.getBoundingClientRect();
            return { nodeId: e.element.dataset.node, slotId: e.element.dataset.slot,
              x: (r.x - bounds.x) / scale, y: (r.y - bounds.y) / scale,
              width: r.width / scale, height: r.height / scale, ...(e.framing ? { framing:e.framing } : {}), ...(e.appearance ? { appearance: e.appearance } : {}) };
          });
          acknowledged=true;
          port.postMessage({ type: 'prepared', revision: p.revision, width, height, slots });
        };
        // Off-air browser surfaces may throttle animation frames. Layout
        // measurement is independent of whether a GPU frame was presented.
        requestAnimationFrame(() => requestAnimationFrame(prepare));
        setTimeout(prepare,100);
      } catch { port.postMessage({ type: 'error' }); }
    };
    port.start(); port.postMessage({ type: 'connected' });
  });
  new ResizeObserver(fit).observe(document.body);
  parent.postMessage('presentation.ready', '*');
})();

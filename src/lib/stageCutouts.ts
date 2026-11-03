import { ipc } from "./ipc";

/**
 * Windows float mode: the native preview window sits ABOVE the webview, so a
 * popover, menu, or toast that opens over the stage is hidden by the video.
 * This watches the DOM for such elements, reports their rects to the engine,
 * and the engine punches them out of the preview window so they show through
 * (and receive the mouse) exactly there. Harmless on macOS: the command is a
 * no-op where the preview already sits below the webview.
 *
 * Elements are found by selector, not by registration, so a new popover
 * needs nothing beyond one of these classes.
 */
const OVERLAY_SELECTOR = [
  ".rm-pop",          // every Pop() portal (channels, devices, layout, quality, add…)
  // Room chrome that is absolutely/fixed positioned and can sit over the stage
  // (App.css). The bottom sheet's head (mic / camera / more pill + handle) was
  // the visible casualty; the rest are the same shape of element.
  ".rm-sheet-head",
  ".rm-sheet:not(.collapsed)",
  ".rm-dock.armed",
  ".rm-add-panel",
  ".rm-panel-guests",
  ".rm-editor",
  ".rm-ghost",
  ".rm-veil",
  ".rm-chat-jump",
  "[role='menu']",
  "[role='dialog']",
  "dialog[open]",    // HTML dialogs have an implicit role, not a role attribute
  "[role='listbox']",
  "[data-over-stage]", // opt-in for anything else
].join(",");

type R = { x: number; y: number; w: number; h: number };
let last = "";
let scheduled = 0;

function visible(el: Element): boolean {
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" && el.getClientRects().length > 0;
}

function collect(): R[] {
  // A modal's backdrop covers the whole webview, beyond the dialog's bounds.
  // Give it priority over the bounded popover list. Clip the native displays,
  // not the program sources: recording, camera and guest output keep running.
  if ([...document.querySelectorAll("dialog:modal, [aria-modal='true'], .rm-modal-backdrop")].some(visible)) {
    return [{ x: 0, y: 0, w: Math.ceil(window.innerWidth), h: Math.ceil(window.innerHeight) }];
  }
  const out: R[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (!visible(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const x = Math.floor(b.left), y = Math.floor(b.top);
    out.push({ x, y, w: Math.ceil(b.right) - x, h: Math.ceil(b.bottom) - y });
    if (out.length >= 16) break;
  }
  return out;
}

function flush() {
  scheduled = 0;
  const rects = collect();
  const key = JSON.stringify(rects);
  if (key === last) return;
  last = key;
  ipc.livePreviewCutouts(rects).catch(() => {});
}

function schedule() {
  // Native video can occlude WebView2/WebKit and suspend animation frames.
  // Opening a dialog must still update its native clipping region promptly.
  if (!scheduled) scheduled = window.setTimeout(flush, 0);
}

let installed = false;
/** Idempotent; call once from the room view. */
export function installStageCutouts() {
  if (installed) return;
  installed = true;
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-modal"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  // Animated popovers move for a few frames after they mount: settle them.
  const tick = () => { schedule(); setTimeout(tick, 250); };
  tick();
}

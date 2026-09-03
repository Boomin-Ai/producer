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
  ".rm-banner",       // engine error / status banner over the stage
  ".rm-float",        // its float container
  "[role='menu']",
  "[role='dialog']",
  "[role='listbox']",
  "[data-over-stage]", // opt-in for anything else
].join(",");

type R = { x: number; y: number; w: number; h: number };
let last = "";
let raf = 0;

function collect(): R[] {
  const out: R[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    out.push({ x: Math.floor(b.left), y: Math.floor(b.top), w: Math.ceil(b.width), h: Math.ceil(b.height) });
    if (out.length >= 16) break;
  }
  return out;
}

function flush() {
  raf = 0;
  const rects = collect();
  const key = JSON.stringify(rects);
  if (key === last) return;
  last = key;
  ipc.livePreviewCutouts(rects).catch(() => {});
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(flush);
}

let installed = false;
/** Idempotent; call once from the room view. */
export function installStageCutouts() {
  if (installed) return;
  installed = true;
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  // Animated popovers move for a few frames after they mount: settle them.
  const tick = () => { schedule(); setTimeout(tick, 250); };
  tick();
}

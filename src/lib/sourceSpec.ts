/** Open-list source spec (UI-P2.10 item-list model). Tagged for serde —
 * the Rust twin is `ExtraSpec` in src-tauri/src/live/graph.rs. DOM-free so
 * the room document (lib/roomConfig.ts) and its tests can import it. */
export type ExtraSpec =
  | { kind: "media"; path: string; looping?: boolean }
  | { kind: "image"; path: string }
  | { kind: "text"; text: string; size?: number; color?: string }
  | { kind: "color"; color: string }
  | { kind: "window"; window: number }
  /** v0.4.34: capture is ordinary. A webcam/capture card by libobs device id
   * (absent = system default). Its own audio stays out of the mix. */
  | { kind: "camera"; device?: string }
  /** One display by platform id (CG UUID / Windows monitor_id; absent = main). */
  | { kind: "screen"; display?: string }
  /** An audio input by libobs device id (absent = system default input). */
  | { kind: "mic"; device?: string }
  | { kind: "guest"; url: string }
  /** A seated MOD's feed (v0.4.32): the same render page a guest uses, but
   * its own source kind — own label, layer, placement; never a guest slot. */
  | { kind: "mod"; url: string }
  /** A page rendered on the set, fed by THIS Producer over the local bridge (#51). */
  | { kind: "overlay"; url: string };


/** Stage-editor transform patch: only present fields are applied (the Rust
 * twin is `TransformPatch` in graph.rs). */
export interface LiveTransformPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  crop_left?: number;
  crop_top?: number;
  crop_right?: number;
  crop_bottom?: number;
  z?: number;
  visible?: boolean;
}

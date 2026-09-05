import { invoke } from "@tauri-apps/api/core";

/** One filter in a source's chain, as the engine reports it. */
export interface FilterState {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Record<string, number | string | boolean>;
}

export type FilterOp =
  | { op: "list" }
  | { op: "add"; kind: string; name: string }
  | { op: "remove"; name: string }
  | { op: "enable"; name: string; on: boolean }
  | { op: "reorder"; name: string; movement: number }
  | { op: "update"; name: string; settings: Record<string, number | string | boolean> };

/** Every call answers with the chain's new state, so the UI never models it. */
export const filters = (source: string, op: FilterOp) =>
  invoke<FilterState[]>("live_filters", { source, op });

/** One property control in a filter's form. */
export interface FilterProp {
  key: string;
  label: string;
  kind: "slider" | "choice";
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number ("%", "dB", "ms"). */
  unit?: string;
  choices?: { value: string; label: string }[];
  /** Only render while another setting holds this value (a slider that
   * means nothing in the other modes). */
  showWhen?: { key: string; value: string };
}

export interface FilterSpec {
  kind: string;
  label: string;
  /** What it's for, in the words a streamer would use. */
  hint: string;
  media: "video" | "audio";
  props: FilterProp[];
}

/** The launch set: the filters people actually reach for. The engine ships
 * ~20; these ten cover the standard webcam and microphone chains. */
export const FILTER_CATALOG: FilterSpec[] = [
  {
    // Producer's own filter (person_mask.m): Apple Vision person
    // segmentation on macOS; a pass-through on Windows until it has a mask
    // provider. Opt-in — nothing attaches it to a new source.
    kind: "producer_person_mask",
    label: "Cutout",
    hint: "Removes your background. Soft blurs it; Cut removes it so you can sit on a set.",
    media: "video",
    props: [
      {
        key: "mode",
        label: "Mode",
        kind: "choice",
        choices: [
          { value: "off", label: "Off" },
          { value: "soft", label: "Soft" },
          { value: "cut", label: "Cut" },
        ],
      },
      { key: "feather", label: "Feather", kind: "slider", min: 0, max: 1, step: 0.01 },
      { key: "erode", label: "Erode", kind: "slider", min: 0, max: 1, step: 0.01 },
      {
        key: "blur",
        label: "Blur radius",
        kind: "slider",
        min: 0,
        max: 1,
        step: 0.01,
        showWhen: { key: "mode", value: "soft" },
      },
    ],
  },
  {
    kind: "chroma_key_filter_v2",
    label: "Chroma Key",
    hint: "Remove a green (or blue) screen",
    media: "video",
    props: [
      {
        key: "key_color_type",
        label: "Key colour",
        kind: "choice",
        choices: [
          { value: "green", label: "Green" },
          { value: "blue", label: "Blue" },
          { value: "magenta", label: "Magenta" },
        ],
      },
      { key: "similarity", label: "Similarity", kind: "slider", min: 1, max: 1000, step: 1 },
      { key: "smoothness", label: "Smoothness", kind: "slider", min: 1, max: 1000, step: 1 },
      { key: "spill", label: "Spill reduction", kind: "slider", min: 1, max: 1000, step: 1 },
    ],
  },
  {
    kind: "color_filter_v2",
    label: "Color Correction",
    hint: "Fix a washed-out or off-colour camera",
    media: "video",
    props: [
      { key: "brightness", label: "Brightness", kind: "slider", min: -1, max: 1, step: 0.01 },
      { key: "contrast", label: "Contrast", kind: "slider", min: -2, max: 2, step: 0.01 },
      { key: "saturation", label: "Saturation", kind: "slider", min: -1, max: 5, step: 0.01 },
      { key: "hue_shift", label: "Hue shift", kind: "slider", min: -180, max: 180, step: 1, unit: "°" },
      { key: "gamma", label: "Gamma", kind: "slider", min: -3, max: 3, step: 0.01 },
    ],
  },
  {
    kind: "luma_key_filter_v2",
    label: "Luma Key",
    hint: "Remove by brightness — for overlays without transparency",
    media: "video",
    props: [
      { key: "luma_min", label: "Luma min", kind: "slider", min: 0, max: 1, step: 0.01 },
      { key: "luma_min_smooth", label: "Min smoothness", kind: "slider", min: 0, max: 1, step: 0.01 },
      { key: "luma_max", label: "Luma max", kind: "slider", min: 0, max: 1, step: 0.01 },
      { key: "luma_max_smooth", label: "Max smoothness", kind: "slider", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    kind: "sharpness_filter_v2",
    label: "Sharpen",
    hint: "Crisp up a soft capture-card feed",
    media: "video",
    props: [{ key: "sharpness", label: "Sharpness", kind: "slider", min: 0, max: 1, step: 0.01 }],
  },
  {
    kind: "noise_suppress_filter_v2",
    label: "Noise Suppression",
    hint: "Kill fan, air-con and keyboard noise",
    media: "audio",
    props: [
      { key: "suppress_level", label: "Suppression", kind: "slider", min: -60, max: 0, step: 1, unit: "dB" },
    ],
  },
  {
    kind: "noise_gate_filter",
    label: "Noise Gate",
    hint: "Mute the mic when you're not talking",
    media: "audio",
    props: [
      { key: "open_threshold", label: "Open at", kind: "slider", min: -96, max: 0, step: 1, unit: "dB" },
      { key: "close_threshold", label: "Close at", kind: "slider", min: -96, max: 0, step: 1, unit: "dB" },
      { key: "attack_time", label: "Attack", kind: "slider", min: 0, max: 500, step: 1, unit: "ms" },
      { key: "hold_time", label: "Hold", kind: "slider", min: 0, max: 1000, step: 1, unit: "ms" },
      { key: "release_time", label: "Release", kind: "slider", min: 0, max: 1000, step: 1, unit: "ms" },
    ],
  },
  {
    kind: "compressor_filter",
    label: "Compressor",
    hint: "Even out loud and quiet speech",
    media: "audio",
    props: [
      { key: "ratio", label: "Ratio", kind: "slider", min: 1, max: 32, step: 0.5, unit: ":1" },
      { key: "threshold", label: "Threshold", kind: "slider", min: -60, max: 0, step: 1, unit: "dB" },
      { key: "attack_time", label: "Attack", kind: "slider", min: 1, max: 500, step: 1, unit: "ms" },
      { key: "release_time", label: "Release", kind: "slider", min: 1, max: 1000, step: 1, unit: "ms" },
      { key: "output_gain", label: "Make-up gain", kind: "slider", min: 0, max: 32, step: 0.5, unit: "dB" },
    ],
  },
  {
    kind: "limiter_filter",
    label: "Limiter",
    hint: "Hard ceiling so a shout never clips",
    media: "audio",
    props: [
      { key: "threshold", label: "Threshold", kind: "slider", min: -60, max: 0, step: 1, unit: "dB" },
      { key: "release_time", label: "Release", kind: "slider", min: 1, max: 1000, step: 1, unit: "ms" },
    ],
  },
  {
    kind: "gain_filter",
    label: "Gain",
    hint: "Boost a quiet microphone",
    media: "audio",
    props: [{ key: "db", label: "Gain", kind: "slider", min: -30, max: 30, step: 0.5, unit: "dB" }],
  },
];

export const specOf = (kind: string) => FILTER_CATALOG.find((f) => f.kind === kind);

/** The chain most streamers are told to build, in order. */
export const MIC_CHAIN = [
  "noise_suppress_filter_v2",
  "noise_gate_filter",
  "compressor_filter",
  "limiter_filter",
];

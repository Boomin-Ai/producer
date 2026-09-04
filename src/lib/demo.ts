/** Dev demo mode: populates the room's panels with believable life and
 * plays real gameplay footage through the engine's browser source, so the
 * UI can be designed, screenshotted, and felt without going live.
 * Default ON while pre-launch; the Settings sheet has the switch. */

export const DEMO_KEY = "producer.demo";

export function demoOn(): boolean {
  try {
    // OFF unless switched on: a fresh install must never show a fixture.
    return localStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDemo(on: boolean) {
  try {
    localStorage.setItem(DEMO_KEY, on ? "1" : "0");
  } catch {
    /* fine */
  }
}

/** Halo E3 stage demo (archive.org, direct mp4) wrapped in a cover-fit
 * looping <video>, handed to the CEF browser source as a data URL. */
const DEMO_MP4 = "https://archive.org/download/youtube-bAjzdd4uJtM/bAjzdd4uJtM.mp4";
export const DEMO_VIDEO_URL =
  "data:text/html," +
  encodeURIComponent(
    `<body style="margin:0;background:#000"><video src="${DEMO_MP4}" autoplay muted loop playsinline style="width:100vw;height:100vh;object-fit:cover"></video></body>`,
  );

export type DemoPlatform = "twitch" | "kick" | "youtube";

export interface DemoAlert {
  platform: DemoPlatform;
  kind: "follow" | "sub" | "tip" | "raid";
  user: string;
  detail?: string;
  message?: string;
  ago: string;
}

export const DEMO_ALERTS: DemoAlert[] = [
  { platform: "twitch", kind: "tip", user: "NinjaBytez", detail: "100 bits", ago: "now" },
  { platform: "twitch", kind: "sub", user: "gunko999", detail: "44 months · T2", ago: "6m" },
  { platform: "youtube", kind: "sub", user: "6sidi", detail: "member", ago: "12m" },
  {
    platform: "kick",
    kind: "tip",
    user: "CraftyController",
    detail: "$25",
    message: "GG mate, keep it coming!",
    ago: "18m",
  },
  { platform: "twitch", kind: "follow", user: "meepmerp5", ago: "22m" },
  { platform: "youtube", kind: "sub", user: "VividVortex", detail: "member", ago: "30m" },
];

export interface DemoChatMsg {
  platform: DemoPlatform;
  user: string;
  text: string;
}

export const DEMO_CHAT: DemoChatMsg[] = [
  { platform: "twitch", user: "icyfrostypants", text: "just realized if you subtract 3 from the left the score is 6-7, chills" },
  { platform: "twitch", user: "khhldcrdbl3", text: "thinking back why would he ever go back to that scene" },
  { platform: "kick", user: "wafle0_0", text: "try dodging to the left when he swings" },
  { platform: "youtube", user: "VividVortex", text: "Just followed! Love your content" },
  { platform: "twitch", user: "JJB844", text: "Use your special attack!" },
  { platform: "youtube", user: "6sidi", text: "thats fire" },
  { platform: "kick", user: "gunko999", text: "HOLD" },
  { platform: "twitch", user: "kesilchen", text: "\"ETC\" — legend behavior" },
  { platform: "youtube", user: "saeyaaaa", text: "cause he has so much potential still" },
  { platform: "twitch", user: "nvrmindVAL", text: "like what could've been man" },
  { platform: "kick", user: "night_owl", text: "this room UI is clean, what app is this??" },
  { platform: "twitch", user: "mofo_matt", text: "producer.dev in the title btw" },
];

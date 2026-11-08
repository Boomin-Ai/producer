/** Validate credentials against an independent room read before passing them
 * to the SDK. This is a policy boundary, not a substitute for server fencing. */
import { z } from "zod";

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const source = z.enum(["camera", "microphone", "screen_share", "screen_share_audio"]);
const expectedSchema = z.object({
  brand_id: z.uuid(), room_id: z.uuid(), run_id: z.uuid(), participant_id: z.uuid(),
  role: z.literal("guest"), scope: z.literal("stage"), private_participant_id: z.null(),
  host_lease_epoch: count, control_revision: count, authorization_generation: count,
  endpoint: z.string(), publish_sources: z.array(source).max(4), can_subscribe: z.boolean(),
}).strict();
const stateSchema = z.object({expected: expectedSchema, producer_identity: z.string(), on_stage: z.boolean().optional(), stage_audio:z.array(z.object({
  participant_id:z.uuid(),rtc_identity:z.string(),authorization_generation:count,
  can_publish_audio:z.boolean(),can_subscribe:z.boolean(),
}).strict()).max(25).optional()}).strict();
const sessionSchema = expectedSchema.extend({
  schema_version: z.literal(1), transport: z.literal("livekit"),
  provider_room: z.string(), rtc_identity: z.string(),
  issued_at_ms: count, expires_at_ms: count,
  join_token: z.string().min(16).max(8192),
}).strict();
export type GuestRtcAuthority = z.infer<typeof stateSchema>;
export type GuestRtcSession = z.infer<typeof sessionSchema>;
const invalid = () => new Error("Guest media authorization changed. Wait for the host to stage you again.");

export function readGuestRtcAuthority(value: unknown, participantId: string, pinnedEndpoint: string): GuestRtcAuthority {
  const result = stateSchema.safeParse(value);
  if (!result.success) throw invalid();
  const s = result.data, e = s.expected;
  const host = new RegExp(`^producer-([0-9a-f-]{36})-e${e.host_lease_epoch}-g1$`).exec(s.producer_identity);
  const sources = new Set(e.publish_sources);
  if (e.participant_id !== participantId || e.endpoint !== pinnedEndpoint ||
      !/^wss:\/\/[a-z0-9-]+\.livekit\.cloud$/.test(pinnedEndpoint) ||
      !host || !z.uuid().safeParse(host[1]).success || sources.size !== e.publish_sources.length) throw invalid();
  const seen=new Set<string>();
  for(const peer of s.stage_audio ?? []) {
    if(peer.participant_id===participantId || seen.has(peer.participant_id) ||
      peer.rtc_identity!==`guest-${peer.participant_id}-e${e.host_lease_epoch}-g${peer.authorization_generation}`)throw invalid();
    seen.add(peer.participant_id);
  }
  return s;
}

export function validateGuestRtcSession(value: unknown, authority: GuestRtcAuthority, now = Date.now()): GuestRtcSession {
  const result = sessionSchema.safeParse(value);
  if (!result.success) throw invalid();
  const s = result.data, e = authority.expected;
  for (const key of Object.keys(e) as (keyof typeof e)[]) {
    if (JSON.stringify(s[key]) !== JSON.stringify(e[key])) throw invalid();
  }
  const room = `b_${e.brand_id}_r_${e.room_id}_run_${e.run_id}_stage`;
  const identity = `guest-${e.participant_id}-e${e.host_lease_epoch}-g${e.authorization_generation}`;
  if (s.provider_room !== room || s.rtc_identity !== identity ||
      s.issued_at_ms > now + 30000 || s.expires_at_ms <= now + 2000 ||
      s.expires_at_ms <= s.issued_at_ms || s.expires_at_ms - s.issued_at_ms > 120000) throw invalid();
  return s;
}

/** Routine stage edits change revision but do not change this media binding.
 * Generation, run, role, project or grant changes must retire it immediately. */
export function sameGuestRtcBinding(a: GuestRtcAuthority, b: GuestRtcAuthority): boolean {
  return a.producer_identity === b.producer_identity &&
    Object.keys(a.expected).every(key => key === "control_revision" ||
      JSON.stringify(a.expected[key as keyof typeof a.expected]) === JSON.stringify(b.expected[key as keyof typeof b.expected]));
}

/** A host mute narrows publication rather than making the guest disappear. */
export function guestTrackAllowed(authority: GuestRtcAuthority, kind: string): boolean {
  return kind === "video" ? authority.expected.publish_sources.includes("camera") :
    kind === "audio" && authority.expected.publish_sources.includes("microphone");
}

/** Only staged microphones enter the conversation; cameras remain host-only. */
export function guestPeerAudioAllowed(authority:GuestRtcAuthority,identity:string):boolean {
  return authority.on_stage===true && authority.expected.can_subscribe &&
    (authority.stage_audio ?? []).some(peer=>peer.rtc_identity===identity && peer.can_publish_audio);
}
export function guestAudioRecipients(authority:GuestRtcAuthority):string[] {
  return authority.on_stage===true && guestTrackAllowed(authority,"audio") ?
    (authority.stage_audio ?? []).filter(peer=>peer.can_subscribe).map(peer=>peer.rtc_identity):[];
}

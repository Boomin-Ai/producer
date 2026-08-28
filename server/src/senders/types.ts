// The sender contract — producer-server's community extension point.
// A platform is ONE file implementing this interface. The queue knows
// nothing about any platform; it only understands outcomes, error
// classes, and checkpoints.

export interface ChannelRow {
  id: string;
  platform: string;
  external_id: string;
  display_name: string;
  handle: string | null;
  status: string;
}

export interface JobInput {
  caption: string | null;
  /** Publicly fetchable media URL (capability gateway or external), or null. */
  mediaUrl: string | null;
  mediaKind: "image" | "video" | null;
  overrides: Record<string, unknown>;
}

/** Persisted BEFORE the network call that consumes it — a crashed tick
 *  resumes from the checkpoint instead of re-creating platform objects. */
export type Checkpoint = Record<string, unknown>;

export type StepResult =
  | { done: true; externalId: string; externalUrl?: string; checkpoint: Checkpoint }
  | { done: false; retryInSeconds: number; checkpoint: Checkpoint };

export type SendErrorClass = "retryable" | "token_expired" | "rate_limited" | "permanent";

export class SendError extends Error {
  constructor(
    public errorClass: SendErrorClass,
    message: string,
    /** For rate_limited: when the window reopens (epoch seconds). */
    public retryAt?: number,
  ) {
    super(message);
  }
}

export interface PreflightIssue {
  code: string;
  message: string;
  field?: string;
}

export interface PlatformSender {
  platform: "instagram" | "facebook" | "threads";
  /** Rendered by clients as the source of truth — never hardcoded there. */
  capabilities(): Record<string, unknown>;
  /** Validate BEFORE a job is accepted; issues become a 422 preflight. */
  preflight(input: JobInput): PreflightIssue[];
  /** Advance one step. Re-entrant: persist ids into the checkpoint before
   *  the call that consumes them; throw SendError to classify failures. */
  publish(input: JobInput, checkpoint: Checkpoint, accessToken: string, channel: ChannelRow): Promise<StepResult>;
}

// ── Shared Graph helpers ─────────────────────────────────────────────────────

export async function graphCall<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const err = (body.error ?? {}) as Record<string, unknown>;
    const code = Number(err.code ?? 0);
    const message = String(err.message ?? `platform returned HTTP ${resp.status}`);
    // 190 = invalid/expired token; 4/17/32/613 = rate limits.
    if (code === 190) throw new SendError("token_expired", message);
    if ([4, 17, 32, 613].includes(code)) {
      throw new SendError("rate_limited", message, Math.floor(Date.now() / 1000) + 15 * 60);
    }
    if (resp.status >= 500) throw new SendError("retryable", message);
    throw new SendError("permanent", message);
  }
  return body as T;
}

export function form(params: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, v);
  return body;
}

export function tagList(value: unknown, max: number): string[] {
  const raw = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return raw.map((t) => t.trim().replace(/^@/, "")).filter(Boolean).slice(0, max);
}

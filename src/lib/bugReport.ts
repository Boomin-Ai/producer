// "Report a bug" — the payload, and the redaction that makes it safe to send.
//
// Everything here is PURE (no invoke, no fetch, no DOM) so the interesting part
// — what leaves this machine — is testable: server/test/bug-report.test.ts.
//
// The sheet shows the user exactly this object before it is sent. That promise
// only holds if the same function builds what is previewed and what is posted,
// so `buildReport` is called once and its result is both.

/** What the API's `diagnostics` object accepts. Mirrors the zod schema on
 *  POST /v1/app/support/report — keep the two in step. */
export interface Diagnostics {
  version: string;
  os: string;
  arch: string;
  engine?: string;
  encoder?: string;
  gpu?: string;
  room?: { scenes: number; sources: number };
  log?: string;
}

export interface BugReport {
  text: string;
  diagnostics?: Diagnostics;
  contact?: string;
}

/** The API's cap on the log tail. Trim here so an oversize log is a shorter
 *  report rather than a 400 the user has to decode. */
export const LOG_LIMIT = 8000;
/** The API's cap on the report text. */
export const TEXT_LIMIT = 4000;

// ── redaction ────────────────────────────────────────────────────────────────
//
// The log tail is the one field the user did not type, so it is the one field
// that can carry something they never meant to send. Producer's own logs are
// tame, but a log is an append-only surface anyone can add a line to, and a
// bug report becomes a PUBLIC GitHub issue — the blast radius of one leaked
// token is the whole workspace.
//
// So the rule is deliberately blunt, and deliberately biased toward destroying
// signal rather than preserving it: match the SHAPES credentials come in, and
// replace the value — never the surrounding line, which is what made the log
// worth attaching. A false positive costs a debugging hint; a false negative
// costs a token. We take the false positives.
//
// Six shapes, in the order they must be applied (longest context first, so a
// bearer token is caught as a bearer token before the generic long-token rule
// gets to it):
//
//   1. `Authorization: Bearer <token>` / a bare `Bearer <token>`
//   2. `token`/`secret`/`password`/`api[-_ ]key`/`apikey`/`auth` = <value>,
//      in `k=v`, `k: v` and `"k": "v"` forms
//   3. Known vendor key prefixes (sk_, pk_, rk_, whsec_, ghp_, gho_, ghu_,
//      ghs_, ghr_, github_pat_, re_, xoxb-, AKIA…)
//   4. JWTs (three base64url segments separated by dots)
//   5. A `?…&token=…`-style query parameter inside a URL
//   6. Any remaining run of 32+ base64url-ish characters that is not a plain
//      word — the catch-all for a credential shape we have not met yet
//
export const REDACTED = "[redacted]";

const RULES: Array<[RegExp, string]> = [
  // 1. Bearer tokens, with or without the header name.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // 2. Named secrets in k=v / k: v / "k": "v" form. The key survives (it is the
  //    useful half); the value does not.
  [
    /\b(authorization|auth|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|api[_-]?key|apikey|api[_-]?secret|client[_-]?secret|private[_-]?key)("?\s*[:=]\s*"?)[^\s",;}&]+/gi,
    `$1$2${REDACTED}`,
  ],
  // 3. Vendor-prefixed keys, which are recognisable on sight and worth catching
  //    even when they appear bare in a sentence.
  [/\b(sk|pk|rk|whsec|ghp|gho|ghu|ghs|ghr|re)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{12,}/g, REDACTED],
  // 4. JWTs — three base64url segments. Producer's own session token is one.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // 5. Credentials smuggled through a URL's query string.
  [/([?&](?:token|key|api[_-]?key|access[_-]?token|secret|signature|sig|code)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // 6. The catch-all: a long opaque run. Requires BOTH a digit and a letter and
  //    at least one case change or separator, so ordinary long words, hex-ish
  //    log ids and file paths survive while real keys do not.
  [/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s]*[0-9])(?=[^\s]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, REDACTED],
];

/**
 * Strip anything that looks like a credential out of a log tail.
 *
 * Applied to the log BEFORE the sheet previews it, so what the user is shown is
 * literally what is sent — the preview is not a separate rendering that could
 * drift from the payload.
 */
export function redactSecrets(log: string): string {
  let out = log;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Keep the LAST `limit` characters — the tail is the interesting end — and say
 *  so, rather than silently dropping the beginning. */
export function trimLog(log: string, limit = LOG_LIMIT): string {
  if (log.length <= limit) return log;
  const marker = "…(earlier lines trimmed)\n";
  return marker + log.slice(-(limit - marker.length));
}

// ── the payload ──────────────────────────────────────────────────────────────

export interface ReportInput {
  text: string;
  /** Unchecked "Attach diagnostics" ⇒ no diagnostics object at all. */
  attachDiagnostics: boolean;
  contact?: string;
  version: string | null;
  os: string;
  arch: string;
  engine?: string | null;
  encoder?: string | null;
  gpu?: string | null;
  scenes?: number | null;
  sources?: number | null;
  /** Raw tail from `ui_log_tail`; redacted and trimmed here, never by the caller. */
  log?: string | null;
}

const clean = (v: string | null | undefined): string | undefined => {
  const s = (v ?? "").trim();
  return s ? s : undefined;
};

/**
 * The one builder. Its output is what the sheet previews AND what is posted —
 * see the file header. Absent optional fields are OMITTED rather than sent as
 * null, because the API's schema is `.strict()` and a null would 400.
 */
export function buildReport(input: ReportInput): BugReport {
  const report: BugReport = { text: input.text.trim().slice(0, TEXT_LIMIT) };
  const contact = clean(input.contact);
  if (contact) report.contact = contact;
  if (!input.attachDiagnostics) return report;

  const diagnostics: Diagnostics = {
    version: clean(input.version) ?? "unknown",
    os: input.os,
    arch: input.arch,
  };
  const engine = clean(input.engine);
  if (engine) diagnostics.engine = engine;
  const encoder = clean(input.encoder);
  if (encoder) diagnostics.encoder = encoder;
  const gpu = clean(input.gpu);
  if (gpu) diagnostics.gpu = gpu;
  if (typeof input.scenes === "number" && typeof input.sources === "number") {
    diagnostics.room = { scenes: input.scenes, sources: input.sources };
  }
  const log = trimLog(redactSecrets(input.log ?? "").trim());
  if (log) diagnostics.log = log;

  report.diagnostics = diagnostics;
  return report;
}

// ── the failure path ─────────────────────────────────────────────────────────
//
// If the post fails, what the user typed must not evaporate. Two exits, both
// built from the SAME report object, so neither can disagree with what would
// have been sent.

export const REPO_URL = "https://github.com/Boomin-Ai/producer";

/** The report as plain text, for the clipboard. */
export function reportToText(report: BugReport): string {
  const lines = [report.text];
  if (report.contact) lines.push("", `Reply to: ${report.contact}`);
  if (report.diagnostics) lines.push("", "Diagnostics:", JSON.stringify(report.diagnostics, null, 2));
  return lines.join("\n");
}

/** A prefilled "new issue" URL. GitHub rejects very long query strings, so the
 *  body is capped well under the limit — the point is that the user lands on a
 *  form with their words already in it, not that every log line survives. */
export function githubIssueUrl(report: BugReport): string {
  const title = report.text.trim().split("\n")[0]!.slice(0, 120) || "Producer bug report";
  const body = reportToText(report).slice(0, 5000);
  const params = new URLSearchParams({ title, body, labels: "bug,from-app" });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

import { describe, expect, it } from "vitest";
import {
  buildReport,
  githubIssueUrl,
  REDACTED,
  redactSecrets,
  reportToText,
  trimLog,
} from "../../src/lib/bugReport";

// The log tail is the one field the user did not type, and a bug report becomes
// a PUBLIC GitHub issue — so redaction is the part of this feature that has to
// be right. The rule is deliberately biased: destroy signal rather than leak a
// credential. These tests pin both halves of that trade — every credential shape
// we know dies, and the ordinary log lines around it survive.

describe("redactSecrets", () => {
  it("kills a bearer token but keeps the line that carried it", () => {
    const out = redactSecrets("12 [api] GET /v1/app/auth/me Authorization: Bearer " + "eyJ" + "hbGciOiJIUzI1NiJ9.abc.def");
    expect(out).not.toContain("hbGciOiJIUzI1NiJ9");
    expect(out).toContain("[api] GET /v1/app/auth/me");
    expect(out).toContain(REDACTED);
  });

  it("keeps the KEY of a named secret and destroys only the value", () => {
    const out = redactSecrets('token="abcd1234efgh5678" room=main');
    expect(out).toContain("token=");
    expect(out).toContain("room=main"); // the neighbouring field is untouched
    expect(out).not.toContain("abcd1234efgh5678");
  });

  // Fixtures are ASSEMBLED, never written out whole. These are invented values,
  // but a literal that matches a vendor's key pattern trips GitHub's push
  // protection (it blocked this very file once) and every credential scanner
  // downstream forever after. `key()` keeps the shapes under test without ever
  // putting a scannable string in the source.
  const key = (prefix: string, ...body: string[]) => prefix + body.join("");

  it.each([
    ["k=v", () => `api_key=${key("sk_live_", "51H8xQ2eZvKYlo2C")}`],
    ["colon", () => "secret: hunter2hunter2hunter2"],
    ["json", () => '"password": "correct horse battery"'],
    ["header", () => "authorization: Basic Zm9vOmJhcg=="],
  ])("redacts a named secret in %s form", (_shape, line) => {
    expect(redactSecrets(line())).toContain(REDACTED);
  });

  it.each([
    ["stripe", () => key("sk_", "live_", "51H8xQ2eZvKYlo2CabcdEFGH")],
    ["stripe publishable", () => key("pk_", "test_", "51H8xQ2eZvKYlo2CabcdEFGH")],
    ["webhook", () => key("whsec_", "9f8e7d6c5b4a3210fedcba98")],
    ["github classic", () => key("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a")],
    ["github fine-grained", () => key("github_", "pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz012345")],
    ["resend", () => key("re_", "123456789abcdefghijkl")],
    ["slack", () => key("xoxb-", "1234567890-abcdefghijkl")],
    ["aws", () => key("AKIA", "IOSFODNN7EXAMPLE")],
  ])("redacts a bare %s key even with no key= in front of it", (_vendor, make) => {
    const secret = make();
    expect(redactSecrets(`engine boot ok ${secret} done`)).not.toContain(secret);
  });

  it("redacts a JWT anywhere in a line", () => {
    const jwt = key("eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".eyJzdWIiOiIxMjM0NSJ9", ".dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(redactSecrets(`ticket ${jwt} accepted`)).not.toContain(jwt);
  });

  it("redacts a credential smuggled through a URL query string", () => {
    const out = redactSecrets("GET https://api.boomin.ai/v1/app/live?token=9f8e7d6c5b4a3210&room=main");
    expect(out).not.toContain("9f8e7d6c5b4a3210");
    expect(out).toContain("room=main");
    expect(out).toContain("https://api.boomin.ai/v1/app/live"); // the URL still reads
  });

  it("catches a long opaque token we have no specific rule for", () => {
    const unknown = "Zq7Lm2Xr9Tv4Bn8Kd1Wc6Yf3Hj5Pg0Sa2Ue";
    expect(redactSecrets(`x-vendor-cred ${unknown}`)).not.toContain(unknown);
  });

  it("leaves an ordinary log line completely alone — the tail has to stay useful", () => {
    const line =
      "1757000000000 [monitor] room 8f2 opened in 1.84s · metal · VideoToolbox · 3 scenes 7 sources fps=60 cpu=18";
    expect(redactSecrets(line)).toBe(line);
  });

  it("leaves file paths and long ordinary words alone", () => {
    const line = "1757000000000 wrote /Users/someone/Library/Logs/ai.boomin.producer/producer-ui.log";
    expect(redactSecrets(line)).toBe(line);
  });

  it("is idempotent — redacting twice changes nothing more", () => {
    const once = redactSecrets("Authorization: Bearer eyJabc.def.ghi");
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("trimLog", () => {
  it("keeps the TAIL, which is the end that matters, and says it trimmed", () => {
    const log = "old\n".repeat(4000) + "THE LAST LINE";
    const out = trimLog(log, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("THE LAST LINE");
    expect(out).toContain("earlier lines trimmed");
  });

  it("leaves a short log untouched", () => {
    expect(trimLog("two lines\nof log", 200)).toBe("two lines\nof log");
  });
});

describe("buildReport", () => {
  const base = {
    text: "The monitor went black after Enter",
    attachDiagnostics: true,
    version: "0.4.43",
    os: "macos",
    arch: "aarch64",
    engine: "metal",
    encoder: "VideoToolbox",
    scenes: 3,
    sources: 7,
  };

  it("builds the payload the API's schema accepts", () => {
    const r = buildReport(base);
    expect(r.text).toBe("The monitor went black after Enter");
    expect(r.diagnostics).toMatchObject({
      version: "0.4.43",
      os: "macos",
      arch: "aarch64",
      engine: "metal",
      encoder: "VideoToolbox",
      room: { scenes: 3, sources: 7 },
    });
  });

  it("sends NO diagnostics key at all when the box is unchecked", () => {
    const r = buildReport({ ...base, attachDiagnostics: false, log: "Bearer abcdefghijkl" });
    expect(r.diagnostics).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("abcdefghijkl");
  });

  it("redacts the log on the way into the payload — the caller never has to remember to", () => {
    const r = buildReport({ ...base, log: "12 boot ok\n13 Authorization: Bearer eyJabc.defgh.ijklm\n" });
    expect(r.diagnostics!.log).toContain("boot ok");
    expect(r.diagnostics!.log).not.toContain("eyJabc.defgh.ijklm");
  });

  it("OMITS optional fields rather than sending null — the API schema is strict()", () => {
    const r = buildReport({ ...base, engine: null, encoder: "", gpu: undefined, log: "   " });
    const d = r.diagnostics!;
    expect("engine" in d).toBe(false);
    expect("encoder" in d).toBe(false);
    expect("gpu" in d).toBe(false);
    expect("log" in d).toBe(false);
    // Nothing in the object is ever literally null.
    expect(JSON.stringify(r)).not.toContain("null");
  });

  it("omits room counts unless BOTH are known — half a room shape is a lie", () => {
    expect(buildReport({ ...base, sources: null }).diagnostics!.room).toBeUndefined();
    expect(buildReport({ ...base, scenes: 0, sources: 0 }).diagnostics!.room).toEqual({ scenes: 0, sources: 0 });
  });

  it("keeps a contact only when one was typed", () => {
    expect(buildReport({ ...base, contact: "  me@example.com " }).contact).toBe("me@example.com");
    expect(buildReport({ ...base, contact: "   " }).contact).toBeUndefined();
  });

  it("clamps text and log to the API's caps so an over-long report is short, not a 400", () => {
    const r = buildReport({ ...base, text: "x".repeat(5000), log: "y".repeat(20000) });
    expect(r.text.length).toBe(4000);
    expect(r.diagnostics!.log!.length).toBeLessThanOrEqual(8000);
  });

  it("says version 'unknown' rather than dropping the field when getVersion() has not answered", () => {
    expect(buildReport({ ...base, version: null }).diagnostics!.version).toBe("unknown");
  });
});

describe("the failure path carries the same report", () => {
  const report = buildReport({
    text: "Black monitor\nafter pressing Enter",
    attachDiagnostics: true,
    contact: "me@example.com",
    version: "0.4.43",
    os: "macos",
    arch: "aarch64",
  });

  it("reportToText includes what the user typed, their reply-to, and the diagnostics", () => {
    const txt = reportToText(report);
    expect(txt).toContain("Black monitor");
    expect(txt).toContain("Reply to: me@example.com");
    expect(txt).toContain('"arch": "aarch64"');
  });

  it("githubIssueUrl prefills the title from the first line and the body from the report", () => {
    const url = new URL(githubIssueUrl(report));
    expect(url.origin + url.pathname).toBe("https://github.com/Boomin-Ai/producer/issues/new");
    expect(url.searchParams.get("title")).toBe("Black monitor");
    expect(url.searchParams.get("body")).toContain("after pressing Enter");
    expect(url.searchParams.get("labels")).toBe("bug,from-app");
  });

  it("an empty report still produces a usable issue title", () => {
    const empty = buildReport({ text: "  ", attachDiagnostics: false, version: null, os: "macos", arch: "aarch64" });
    expect(new URL(githubIssueUrl(empty)).searchParams.get("title")).toBe("Producer bug report");
  });
});

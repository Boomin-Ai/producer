// The gate decides who meets Guests and Mods. Its two jobs: let the listed
// accounts through, and fail CLOSED for everyone and everything else.
import { strict as assert } from "node:assert";
import test from "node:test";
import { flagsFor, isAllowlisted, panelAllowed } from "../src/lib/featureFlags";

test("listed accounts hold both flags", () => {
  for (const e of ["team@boomin.ai", "kleveland.bishop@gmail.com", "team@atlantium.ai"]) {
    assert.equal(isAllowlisted(e), true, e);
    assert.deepEqual([...flagsFor(e)].sort(), ["guests", "mods", "network"]);
  }
});

test("case and whitespace do not decide access", () => {
  assert.equal(isAllowlisted("  Team@Boomin.AI  "), true);
  assert.equal(isAllowlisted("KLEVELAND.BISHOP@GMAIL.COM"), true);
});

test("everyone else is gated", () => {
  for (const e of ["someone@example.com", "team@boomin.ai.evil.com", "xteam@boomin.ai", ""]) {
    assert.equal(isAllowlisted(e), false, e);
    assert.equal(flagsFor(e).size, 0, e);
  }
});

test("an unidentified account fails CLOSED", () => {
  // Offline, no endpoint, /auth/me down: no flags, never "allow by default".
  assert.equal(flagsFor(null).size, 0);
  assert.equal(flagsFor(undefined).size, 0);
});

test("only guests and mods are gated — vote and the rest stay", () => {
  const none = new Set<never>();
  for (const p of ["scenes", "sources", "mixer", "chat", "channels", "vote", "stats", "updates"]) {
    assert.equal(panelAllowed(p, none as never), true, `${p} must not be gated`);
  }
  assert.equal(panelAllowed("guests", none as never), false);
  assert.equal(panelAllowed("mods", none as never), false);
  assert.equal(panelAllowed("guests", flagsFor("team@boomin.ai")), true);
  assert.equal(panelAllowed("mods", flagsFor("team@boomin.ai")), true);
});

test("the Network rail is gated too, and is not a panel", () => {
  // It lives on the home screen, not in a dock — so it is a flag with no
  // PANEL_FLAG entry, and panelAllowed must not accidentally claim it.
  assert.equal(flagsFor("team@boomin.ai").has("network"), true);
  assert.equal(flagsFor("someone@example.com").has("network"), false);
  assert.equal(flagsFor(null).has("network"), false);
});

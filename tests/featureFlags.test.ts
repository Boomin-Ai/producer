// Guests are public; Mods and Network still require allowlist access.
import { strict as assert } from "node:assert";
import test from "node:test";
import { flagsFor, isAllowlisted, panelAllowed, FEATURE_FLAGS } from "../src/lib/featureFlags.ts";

test("listed accounts hold public Guests and both gated capabilities", () => {
  for (const e of ["team@boomin.ai", "kleveland.bishop@gmail.com", "team@atlantium.ai"]) {
    assert.equal(isAllowlisted(e), true, e);
    assert.deepEqual([...flagsFor(e)].sort(), ["guests", "mods", "network"]);
  }
});

test("case and whitespace do not decide access", () => {
  assert.equal(isAllowlisted("  Team@Boomin.AI  "), true);
  assert.equal(isAllowlisted("KLEVELAND.BISHOP@GMAIL.COM"), true);
});

test("everyone else gets Guests without gated capabilities", () => {
  for (const e of ["someone@example.com", "team@boomin.ai.evil.com", "xteam@boomin.ai", ""]) {
    assert.equal(isAllowlisted(e), false, e);
    assert.deepEqual([...flagsFor(e)], ["guests"], e);
  }
});

test("an unidentified account gets Guests while gated capabilities fail closed", () => {
  assert.deepEqual([...flagsFor(null)], ["guests"]);
  assert.deepEqual([...flagsFor(undefined)], ["guests"]);
});

test("only mods are gated in the dock panels", () => {
  const none = new Set<never>();
  for (const p of ["scenes", "sources", "mixer", "chat", "channels", "vote", "stats", "updates"]) {
    assert.equal(panelAllowed(p, none as never), true, `${p} must not be gated`);
  }
  assert.equal(panelAllowed("guests", none as never), true);
  assert.equal(panelAllowed("mods", none as never), false);
  assert.equal(panelAllowed("guests", flagsFor("team@boomin.ai")), true);
  assert.equal(panelAllowed("mods", flagsFor("team@boomin.ai")), true);
});

test("Guests is absent from the Settings feature flag readout", () => {
  assert.equal(FEATURE_FLAGS.some((flag) => flag.id === "guests"), false);
});

test("the Network rail is gated too, and is not a panel", () => {
  // It lives on the home screen, not in a dock — so it is a flag with no
  // PANEL_FLAG entry, and panelAllowed must not accidentally claim it.
  assert.equal(flagsFor("team@boomin.ai").has("network"), true);
  assert.equal(flagsFor("someone@example.com").has("network"), false);
  assert.equal(flagsFor(null).has("network"), false);
});

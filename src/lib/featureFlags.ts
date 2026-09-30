// ── Feature flags ─────────────────────────────────────────────────────────
//
// Guests are available to everyone. Mods and Network remain account gated.
//
// The gate is an ALLOWLIST of accounts, not a switch. Nobody can turn these on
// from the UI — the Settings section is a readout with an address to write to,
// because the honest answer today is "talk to us", not "here is a toggle that
// enables something broken".
//
// Gated capabilities FAIL CLOSED. An account we cannot identify — offline, no endpoint, /auth/me
// down, a self-hosted room with no Boomin account at all — gets the gated
// build. The whole point is that strangers never meet these features by
// accident; a flag that opens itself when the network hiccups does not do that.
// The cost is that a listed account offline sees the gated build too.

/** Accounts that get the ungated build. Lowercased on compare. */
export const FLAG_ALLOWLIST: readonly string[] = [
  "team@boomin.ai",
  "kleveland.bishop@gmail.com",
  "team@atlantium.ai",
];

/** Gated capabilities. `vote` is deliberately NOT here: it works, it does not
 *  depend on guests, and it is the good demo. */
export type FeatureFlag = "guests" | "mods" | "network";

export const FEATURE_FLAGS: { id: FeatureFlag; label: string; blurb: string }[] = [
  {
    id: "mods",
    label: "Mods",
    blurb: "Give someone a control seat: they admit guests, cut scenes, and put their own camera on the set.",
  },
  {
    id: "network",
    label: "Boomin Network",
    blurb: "The Network rail on your home screen: brands to work with, who's live now, and deals between rooms.",
  },
];

/** Where to write. One address, said the same way everywhere. */
export const FLAG_CONTACT = "team@boomin.ai";

export function isAllowlisted(email: string | null | undefined): boolean {
  if (!email) return false;
  return FLAG_ALLOWLIST.includes(email.trim().toLowerCase());
}

/** Guests are public; only Mods and Network require allowlist access. */
export function flagsFor(email: string | null | undefined): Set<FeatureFlag> {
  return isAllowlisted(email)
    ? new Set<FeatureFlag>(["guests", "mods", "network"])
    : new Set<FeatureFlag>(["guests"]);
}

/** Panels that only exist when a flag is held. Anything absent here is
 *  ungated (scenes, sources, mixer, chat, channels, vote, stats, updates). */
export const PANEL_FLAG: Partial<Record<string, FeatureFlag>> = {
  mods: "mods",
};

/** Can this panel be shown at all? */
export function panelAllowed(panelId: string, flags: Set<FeatureFlag>): boolean {
  const need = PANEL_FLAG[panelId];
  return !need || flags.has(need);
}

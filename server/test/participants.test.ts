import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRANTS,
  announceTrack,
  controlsFor,
  labelForStream,
  moveInOrder,
  parseTrackAnnouncement,
  participantKind,
  peerOf,
  resolveGrants,
  roleChips,
  roleTitle,
  roomAccessFrom,
  roomRoleFrom,
  seatAccessFrom,
  sourceIdsFor,
  wantedSourceIds,
} from "../guest/src/participants";

describe("resolveGrants", () => {
  it("absent grants → the default guest bundle (an old server behaves as before)", () => {
    expect([...resolveGrants(undefined)].sort()).toEqual([...DEFAULT_GRANTS].sort());
    expect([...resolveGrants({})].sort()).toEqual([...DEFAULT_GRANTS].sort());
    expect([...resolveGrants({ grants: null })].sort()).toEqual([...DEFAULT_GRANTS].sort());
  });

  it("present grants are taken verbatim — an empty list means nothing, not the default", () => {
    expect(resolveGrants({ grants: [] }).size).toBe(0);
    expect([...resolveGrants({ grants: ["media.screen"] })]).toEqual(["media.screen"]);
  });

  it("drops junk entries without failing the row", () => {
    expect([...resolveGrants({ grants: ["media.mic", 3, null, "", "media.camera"] })]).toEqual(["media.mic", "media.camera"]);
  });

  it("the default bundle never includes screen share (the higher grant)", () => {
    expect(DEFAULT_GRANTS).not.toContain("media.screen");
    expect(controlsFor(resolveGrants(undefined)).screen).toBe(false);
  });
});

describe("controlsFor", () => {
  it("renders exactly the controls the grants cover", () => {
    const c = controlsFor(new Set(["media.screen", "media.return_feed"]));
    expect(c).toEqual({ camera: false, mic: false, screen: true, returnFeed: true, hand: false });
  });
  it("an audience-shaped bundle has no media at all", () => {
    const c = controlsFor(new Set(["input.vote", "input.text"]));
    expect(c.camera || c.mic || c.screen || c.returnFeed || c.hand).toBe(false);
  });
});

describe("participantKind", () => {
  it("prefers an explicit kind", () => {
    expect(participantKind({ kind: "member", joined_via: "room_link" })).toBe("member");
    expect(participantKind({ kind: "producer" })).toBe("producer");
  });
  it("falls back to joined_via with the design doc's backfill rule", () => {
    expect(participantKind({ joined_via: "room_link" })).toBe("visitor");
    expect(participantKind({ joined_via: "network" })).toBe("connection");
    expect(participantKind({ joined_via: "invite" })).toBe("visitor");
    expect(participantKind({ joined_via: "invite", guest_brand: { id: "b1" } })).toBe("connection");
  });
  it("unknown or junk → visitor, the weakest identity claim", () => {
    expect(participantKind(undefined)).toBe("visitor");
    expect(participantKind({ kind: "admin" })).toBe("visitor");
    expect(participantKind({ kind: 7, joined_via: 9 })).toBe("visitor");
  });
});

describe("track labels", () => {
  it("round-trips an announcement", () => {
    const a = announceTrack("s1", "screen");
    expect(parseTrackAnnouncement(a)).toEqual({ kind: "track", stream_id: "s1", label: "screen" });
    expect(parseTrackAnnouncement(announceTrack("s1", "screen", true))).toEqual({
      kind: "track", stream_id: "s1", label: "screen", ended: true,
    });
  });
  it("rejects anything that is not a well-formed announcement", () => {
    expect(parseTrackAnnouncement(null)).toBeNull();
    expect(parseTrackAnnouncement({ kind: "sdp" })).toBeNull();
    expect(parseTrackAnnouncement({ kind: "track", stream_id: "", label: "screen" })).toBeNull();
    expect(parseTrackAnnouncement({ kind: "track", stream_id: "s", label: "desk" })).toBeNull();
    expect(parseTrackAnnouncement("track")).toBeNull();
  });
  it("an unlabeled stream is the camera — a stale client can never be mistaken for a screen", () => {
    const labels = new Map([["scr", "screen" as const]]);
    expect(labelForStream(labels, "scr")).toBe("screen");
    expect(labelForStream(labels, "cam")).toBe("camera");
    expect(labelForStream(new Map(), "anything")).toBe("camera");
  });
});

describe("peerOf", () => {
  it("frames without a peer belong to the main (camera) page", () => {
    expect(peerOf({ kind: "hello" })).toBe("main");
    expect(peerOf({ kind: "hello", peer: "main" })).toBe("main");
    expect(peerOf({ kind: "hello", peer: "screen" })).toBe("screen");
    expect(peerOf({ kind: "hello", peer: "other" })).toBe("main");
    expect(peerOf(null)).toBe("main");
  });
});

describe("source ids", () => {
  it("the camera id is the historical guest-<8> and the screen id hangs off it", () => {
    expect(sourceIdsFor("0123456789abcdef")).toEqual({ camera: "guest-01234567", screen: "guest-01234567-screen" });
  });
  it("wants a screen source only for guests holding media.screen", () => {
    const a = { id: "aaaaaaaa-1", grants: ["media.camera", "media.screen"] };
    const b = { id: "bbbbbbbb-1" };
    const c = { id: "cccccccc-1", grants: [] as string[] };
    const w = wantedSourceIds([a, b, c]);
    expect([...w.keys()].sort()).toEqual(["guest-aaaaaaaa", "guest-aaaaaaaa-screen", "guest-bbbbbbbb", "guest-cccccccc"]);
    expect(w.get("guest-aaaaaaaa-screen")).toEqual({ guest: a, track: "screen" });
    expect(w.get("guest-bbbbbbbb")?.track).toBe("camera");
  });
});

describe("roomRoleFrom", () => {
  it("no route (404) or nothing known → host, the behaviour before the route existed", () => {
    expect(roomRoleFrom(null)).toBe("host");
    expect(roomRoleFrom({ available: false })).toBe("host");
    expect(roomRoleFrom({})).toBe("host");
  });
  it("reads the role field, any spelling the contract may settle on", () => {
    expect(roomRoleFrom({ available: true, access: { role: "host" } })).toBe("host");
    expect(roomRoleFrom({ available: true, access: { role: "Owner" } })).toBe("host");
    expect(roomRoleFrom({ available: true, access: { role: "mod" } })).toBe("mod");
    expect(roomRoleFrom({ available: true, access: { role: "editor" } })).toBe("mod");
    expect(roomRoleFrom({ available: true, access: { role: "manager" } })).toBe("manager");
    expect(roomRoleFrom({ available: true, access: { role: "admin" } })).toBe("manager");
    expect(roomRoleFrom({ available: true, access: { role: "viewer" } })).toBe("viewer");
    expect(roomRoleFrom({ available: true, access: { roles: ["viewer", "editor"] } })).toBe("mod");
  });
  it("control capabilities make a mod; their absence makes a viewer", () => {
    expect(roomRoleFrom({ available: true, access: { can: { admit: true, stage: false } } })).toBe("mod");
    expect(roomRoleFrom({ available: true, access: { capabilities: ["room.stage"] } })).toBe("mod");
    expect(roomRoleFrom({ available: true, access: { can: { admit: false }, capabilities: [] } })).toBe("viewer");
    expect(roomRoleFrom({ available: true, access: {} })).toBe("viewer");
    expect(roomRoleFrom({ available: true, access: "junk" })).toBe("viewer");
  });
  it("host flags win over anything else", () => {
    expect(roomRoleFrom({ available: true, access: { is_host: true, role: "viewer" } })).toBe("host");
  });
  it("a refusal (401/403) is never the host — the route exists and said no", () => {
    expect(roomRoleFrom({ available: true, denied: true })).toBe("viewer");
    expect(roomRoleFrom({ available: true, denied: true, access: null })).toBe("viewer");
  });
});

describe("roomAccessFrom (the Boomin DTO, verbatim)", () => {
  // routes/app/live-access.ts: role + via + can (+ grants roster for a
  // manager, participant_grants for anyone with control, implicit flag).
  const modDto = {
    available: true,
    access: {
      room_id: "r1",
      role: "mod",
      via: "grant",
      can: { roster: true, control: true, manage: false, settings: false, interactions: true, scene: true, billing: false },
      grants: null,
      participant_grants: [{ id: "g1", participant_id: "p1", role: "viewer" }],
      implicit: false,
    },
  };
  it("a room MOD is a mod, via the grant, with the server's capability set", () => {
    const a = roomAccessFrom(modDto);
    expect(a.role).toBe("mod");
    expect(a.via).toBe("grant");
    expect(a.known).toBe(true);
    expect(a.can).toEqual({ roster: true, control: true, manage: false, settings: false, interactions: true, scene: true, billing: false });
    expect(roleTitle(a)).toBe("Mod");
    expect(roleChips(a)).toEqual(["cuts scenes", "admits guests", "runs votes"]);
  });
  it("the grants roster (objects, not strings) never reads as a capability", () => {
    const a = roomAccessFrom({
      available: true,
      access: { role: "viewer", via: "grant", can: { roster: true, control: false }, grants: [{ id: "x", room_role: "manager" }] },
    });
    expect(a.role).toBe("viewer");
    expect(a.can.control).toBe(false);
    expect(roleChips(a)).toEqual(["watches the roster"]);
  });
  it("host via brand / org, and the assumed host when the route is missing", () => {
    expect(roleTitle(roomAccessFrom({ available: true, access: { role: "host", via: "brand", can: {} } }))).toBe("Host · via brand");
    expect(roleTitle(roomAccessFrom({ available: true, access: { role: "host", via: "org", can: {} } }))).toBe("Host · via org");
    const assumed = roomAccessFrom({ available: false });
    expect(assumed.role).toBe("host");
    expect(assumed.known).toBe(false);
    expect(assumed.via).toBe("server");
    expect(roleTitle(assumed)).toBe("Host");
  });
  it("a manager keeps manage but not settings", () => {
    const a = roomAccessFrom({ available: true, access: { role: "manager", via: "grant", can: { manage: true, settings: false } } });
    expect(a.role).toBe("manager");
    expect(a.can.manage).toBe(true);
    expect(a.can.settings).toBe(false);
    expect(roleChips(a)).toContain("grants roles");
  });
  it("an open-server mod seat maps its grants onto the same DTO", () => {
    const a = seatAccessFrom(["room.admit", "room.stage", "room.scene", "room.interactions"]);
    expect(a.role).toBe("mod");
    expect(a.via).toBe("seat");
    expect(a.can.scene).toBe(true);
    expect(roleTitle(a, "studio.example")).toBe("Mod seat on studio.example");
    expect(seatAccessFrom(["room.scene"]).can.control).toBe(false);
  });
});

describe("moveInOrder", () => {
  it("swaps with the neighbour and clamps at the ends", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], "zz", 1)).toEqual(["a", "b"]);
  });
});

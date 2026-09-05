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
  roomRoleFrom,
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
    expect(roomRoleFrom({ available: true, access: { role: "manager" } })).toBe("mod");
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

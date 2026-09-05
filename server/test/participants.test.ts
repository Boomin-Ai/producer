import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRANTS,
  announceTrack,
  controlsFor,
  labelForStream,
  parseTrackAnnouncement,
  participantKind,
  peerOf,
  resolveGrants,
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

// Settings → Access stages changes and confirms them in plain words; this
// covers the pure diff → sentences → ordered ops (src/lib/accessDiff.ts).
import { describe, expect, it } from "vitest";
import { changeSentence, diffMember, joinWords, planChanges, type Member } from "../../src/lib/accessDiff";

const member = (over: Partial<Member> = {}): Member => ({
  id: "m1",
  user_id: "u1",
  email: "kb@example.com",
  name: "Kleveland Bishop",
  role: "viewer",
  type: "collaborator",
  created_at: "2026-09-05",
  grants: [
    { id: "g-live", scope_type: "surface", surface_key: "live", folder_id: null, room_id: null, role: "editor" },
    { id: "g-comm", scope_type: "surface", surface_key: "commerce", folder_id: null, room_id: null, role: "editor" },
    { id: "g-room", scope_type: "room", surface_key: null, folder_id: null, room_id: "r1", role: "editor" },
  ],
  ...over,
});
const rooms = [
  { sid: "r1", name: "Room" },
  { sid: "r2", name: "Green Room" },
];

describe("diffMember", () => {
  it("nothing staged that differs → null", () => {
    expect(diffMember(member(), { surfaces: new Set(["live", "commerce"]), rooms: { r1: "mod" } }, rooms)).toBeNull();
    expect(diffMember(member(), { surfaces: new Set(["live", "commerce"]), rooms: {} }, rooms)).toBeNull();
  });

  it("the founder's sentence: gains · loses · becomes · may connect", () => {
    const c = diffMember(member(), { surfaces: new Set(["live", "canvas", "flows", "channels"]), rooms: { r1: "manager" } }, rooms);
    expect(c && changeSentence(c)).toBe("Kleveland Bishop gains Canvas and Flows · loses Commerce · becomes Manager of Room · may connect channels");
  });

  it("orders the calls: surface grants, surface revokes, room grants, room revokes, channels last", () => {
    const c = diffMember(member(), { surfaces: new Set(["canvas", "channels"]), rooms: { r1: "", r2: "viewer" } }, rooms)!;
    expect(c.ops.map((o) => o.kind)).toEqual(["surface.grant", "surface.revoke", "surface.revoke", "room.grant", "room.revoke", "surface.grant"]);
    expect(c.ops[c.ops.length - 1]).toMatchObject({ surfaceKey: "channels" });
    expect(c.ops.find((o) => o.kind === "room.revoke")).toMatchObject({ grantId: "g-room", roomId: "r1" });
    expect(c.ops.find((o) => o.kind === "room.grant")).toMatchObject({ roomId: "r2", grant: "viewer" });
    expect(c.ops.filter((o) => o.kind === "surface.revoke").map((o) => (o as { grantId: string }).grantId)).toEqual(["g-live", "g-comm"]);
  });

  it("losing a seat and the channel grant read in plain words", () => {
    const c = diffMember(member({ grants: [...member().grants, { id: "g-ch", scope_type: "surface", surface_key: "channels", folder_id: null, room_id: null, role: "editor" }] }), { surfaces: new Set(["live", "commerce"]), rooms: { r1: "" } }, rooms)!;
    expect(changeSentence(c)).toBe("Kleveland Bishop loses their seat in Room · may no longer connect channels");
  });

  it("falls back to the email when there is no name", () => {
    const c = diffMember(member({ name: null }), { surfaces: new Set(["live", "commerce", "agents"]), rooms: {} }, rooms)!;
    expect(changeSentence(c)).toBe("kb@example.com gains Agents");
  });

  it("rooms not staged are left alone", () => {
    const c = diffMember(member(), { surfaces: new Set(["live", "commerce"]), rooms: { r2: "mod" } }, rooms)!;
    expect(c.rooms.map((r) => r.sid)).toEqual(["r2"]);
    expect(c.ops).toHaveLength(1);
  });
});

describe("joinWords", () => {
  it("joins the English way", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["A"])).toBe("A");
    expect(joinWords(["A", "B"])).toBe("A and B");
    expect(joinWords(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("planChanges", () => {
  it("keeps member order and drops the unchanged", () => {
    const a = member({ id: "a", name: "A" });
    const b = member({ id: "b", name: "B" });
    const staged = { a: { surfaces: new Set(["live", "commerce"]), rooms: {} }, b: { surfaces: new Set(["live"]), rooms: {} } };
    const out = planChanges([a, b], staged, rooms);
    expect(out.map((c) => c.who)).toEqual(["B"]);
    expect(changeSentence(out[0])).toBe("B loses Commerce");
  });
});

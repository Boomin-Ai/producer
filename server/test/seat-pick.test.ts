// The Mods panel's seating sheet (src/lib/seatPick.ts): who is offered.
import { describe, expect, it } from "vitest";
import type { Member } from "../../src/lib/accessDiff";
import { canSeat, memberLabel, seatCandidates } from "../../src/lib/seatPick";

const m = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  user_id: `u-${id}`,
  email: `${id}@x.test`,
  name: null,
  role: "viewer",
  type: "collaborator",
  created_at: "",
  grants: [],
  ...over,
});

describe("seatCandidates", () => {
  it("drops already-seated members and team-type hosts", () => {
    const list = [
      m("a"),
      m("b"),
      m("owner", { type: "team", role: "owner" }),
      m("ed", { type: "team", role: "editor" }),
      m("tv", { type: "team", role: "viewer" }),
    ];
    expect(seatCandidates(list, ["u-b"]).map((x) => x.id)).toEqual(["a", "tv"]);
  });
  it("is empty for a missing list", () => {
    expect(seatCandidates(null, [])).toEqual([]);
    expect(seatCandidates(undefined, ["u-a"])).toEqual([]);
  });
});

describe("canSeat / memberLabel", () => {
  it("needs a real pick", () => {
    expect(canSeat("", [m("a")])).toBe(false);
    expect(canSeat("zzz", [m("a")])).toBe(false);
    expect(canSeat("a", [m("a")])).toBe(true);
  });
  it("prefers the name, falls back to the email", () => {
    expect(memberLabel(m("a"))).toBe("a@x.test");
    expect(memberLabel(m("a", { name: " Ada " }))).toBe("Ada");
    expect(memberLabel(m("a", { name: "  " }))).toBe("a@x.test");
  });
});

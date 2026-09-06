// The custom Select's keyboard reducer (src/lib/selectKeys.ts): arrows,
// wrap, disabled skipping, Home/End, Enter/Space/Escape, type-ahead.
import { describe, expect, it } from "vitest";
import { CLOSED_SELECT, TYPEAHEAD_MS, selectKeyReduce, stepIndex, typeaheadIndex } from "../../src/lib/selectKeys";

const opts = [
  { value: "", label: "No seat" },
  { value: "admin", label: "Manager" },
  { value: "editor", label: "Mod", disabled: true },
  { value: "viewer", label: "Viewer" },
];

describe("stepIndex", () => {
  it("skips disabled rows and wraps", () => {
    expect(stepIndex(opts, 1, 1)).toBe(3);
    expect(stepIndex(opts, 3, 1)).toBe(0);
    expect(stepIndex(opts, 0, -1)).toBe(3);
    expect(stepIndex(opts, -1, 1)).toBe(0);
    expect(stepIndex(opts, -1, -1)).toBe(3);
    expect(stepIndex(opts, 2, 1)).toBe(3);
    expect(stepIndex([{ value: "x", label: "x", disabled: true }], -1, 1)).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  it("finds the next label starting with the prefix, cycling on a single letter", () => {
    expect(typeaheadIndex(opts, "m", -1)).toBe(1); // Manager (Mod is disabled)
    expect(typeaheadIndex(opts, "m", 1)).toBe(1); // wraps back: the only enabled M
    expect(typeaheadIndex(opts, "v", 0)).toBe(3);
    expect(typeaheadIndex(opts, "no", 3)).toBe(0);
    expect(typeaheadIndex(opts, "zz", 0)).toBe(-1);
  });
});

describe("selectKeyReduce", () => {
  it("open highlights the selected row (or the first enabled)", () => {
    expect(selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: 3 }, opts).state).toMatchObject({ open: true, highlight: 3 });
    expect(selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: 2 }, opts).state.highlight).toBe(0);
    expect(selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: -1 }, opts).state.highlight).toBe(0);
  });
  it("closed: arrows commit the neighbour in place; Enter / Space open; letters commit by type-ahead", () => {
    const down = selectKeyReduce(CLOSED_SELECT, { type: "key", key: "ArrowDown", now: 0, selectedIndex: 1 }, opts);
    expect(down.commit).toBe(3);
    expect(down.state.open).toBe(false);
    expect(down.handled).toBe(true);
    const up = selectKeyReduce(CLOSED_SELECT, { type: "key", key: "ArrowUp", now: 0, selectedIndex: 0 }, opts);
    expect(up.commit).toBe(3);
    expect(selectKeyReduce(CLOSED_SELECT, { type: "key", key: "Enter", now: 0, selectedIndex: 1 }, opts).state.open).toBe(true);
    expect(selectKeyReduce(CLOSED_SELECT, { type: "key", key: " ", now: 0, selectedIndex: 1 }, opts).state.open).toBe(true);
    const v = selectKeyReduce(CLOSED_SELECT, { type: "key", key: "v", now: 5, selectedIndex: 0 }, opts);
    expect(v.commit).toBe(3);
    expect(selectKeyReduce(CLOSED_SELECT, { type: "key", key: "Tab", now: 0, selectedIndex: 0 }, opts).handled).toBe(false);
  });
  it("open: arrows travel (wrapping, skipping disabled), Home/End jump, Enter commits the highlight and closes, Escape closes without a commit", () => {
    let st = selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: 1 }, opts).state;
    st = selectKeyReduce(st, { type: "key", key: "ArrowDown", now: 0, selectedIndex: 1 }, opts).state;
    expect(st.highlight).toBe(3);
    st = selectKeyReduce(st, { type: "key", key: "ArrowDown", now: 0, selectedIndex: 1 }, opts).state;
    expect(st.highlight).toBe(0);
    st = selectKeyReduce(st, { type: "key", key: "End", now: 0, selectedIndex: 1 }, opts).state;
    expect(st.highlight).toBe(3);
    st = selectKeyReduce(st, { type: "key", key: "Home", now: 0, selectedIndex: 1 }, opts).state;
    expect(st.highlight).toBe(0);
    const enter = selectKeyReduce({ ...st, highlight: 3 }, { type: "key", key: "Enter", now: 0, selectedIndex: 1 }, opts);
    expect(enter.commit).toBe(3);
    expect(enter.state.open).toBe(false);
    const esc = selectKeyReduce(st, { type: "key", key: "Escape", now: 0, selectedIndex: 1 }, opts);
    expect(esc.commit).toBeUndefined();
    expect(esc.state.open).toBe(false);
    expect(esc.handled).toBe(true);
    const tab = selectKeyReduce(st, { type: "key", key: "Tab", now: 0, selectedIndex: 1 }, opts);
    expect(tab.state.open).toBe(false);
    expect(tab.handled).toBe(false);
  });
  it("open: type-ahead accumulates within the window and resets after it", () => {
    let st = selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: -1 }, opts).state;
    st = selectKeyReduce(st, { type: "key", key: "v", now: 1000, selectedIndex: -1 }, opts).state;
    expect(st.highlight).toBe(3);
    expect(st.typed).toBe("v");
    st = selectKeyReduce(st, { type: "key", key: "n", now: 1000 + TYPEAHEAD_MS + 1, selectedIndex: -1 }, opts).state;
    expect(st.typed).toBe("n");
    expect(st.highlight).toBe(0);
    st = selectKeyReduce(st, { type: "key", key: "o", now: 1000 + TYPEAHEAD_MS + 100, selectedIndex: -1 }, opts).state;
    expect(st.typed).toBe("no");
    expect(st.highlight).toBe(0);
    // A miss keeps the highlight.
    st = selectKeyReduce(st, { type: "key", key: "z", now: 1000 + TYPEAHEAD_MS + 200, selectedIndex: -1 }, opts).state;
    expect(st.highlight).toBe(0);
  });
  it("hover moves the highlight only onto enabled rows while open", () => {
    const open = selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: 0 }, opts).state;
    expect(selectKeyReduce(open, { type: "hover", index: 3 }, opts).state.highlight).toBe(3);
    expect(selectKeyReduce(open, { type: "hover", index: 2 }, opts).state.highlight).toBe(0);
    expect(selectKeyReduce(CLOSED_SELECT, { type: "hover", index: 3 }, opts).handled).toBe(false);
  });
  it("Enter on a disabled highlight closes without committing", () => {
    const st = { ...selectKeyReduce(CLOSED_SELECT, { type: "open", selectedIndex: 0 }, opts).state, highlight: 2 };
    const r = selectKeyReduce(st, { type: "key", key: "Enter", now: 0, selectedIndex: 0 }, opts);
    expect(r.commit).toBeUndefined();
    expect(r.state.open).toBe(false);
  });
});

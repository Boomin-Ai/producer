// One source of truth for grants, kinds and track labels, shared with the
// guest pages so Producer's roster and the guest's controls can never drift.
// The canonical file lives with the guest bundle because the server's test
// suite (the only one CI runs) exercises it there.
export * from "../../server/guest/src/participants";

// The account's flags, resolved once and shared. Every gated surface reads
// this, so they can never disagree with each other about who you are.
//
// Resolution is async (it asks /auth/me), and the answer starts as "no flags"
// — see lib/featureFlags.ts on failing closed. A brief flicker where a gated
// panel is absent and then appears for a listed account is the right way
// round: the wrong way shows a stranger the broken feature and takes it away.
import { useEffect, useState } from "react";
import { fetchMe } from "./access";
import { flagsFor, type FeatureFlag } from "./featureFlags";
import { WORKSPACE_EVENT, activeEndpointId } from "./workspace";

export interface FlagState {
  flags: Set<FeatureFlag>;
  /** The account we resolved, for the Settings readout. */
  email: string | null;
  /** False until /auth/me answers (or fails). Settings says "checking…". */
  known: boolean;
}

const EMPTY: FlagState = { flags: new Set(), email: null, known: false };

/** The last answer this machine got. NOT authority — /auth/me is, and it
 *  overwrites this the moment it answers. It exists so the FIRST PAINT matches
 *  what the account actually has: resolving after render is what moved the
 *  home screen's rail and the mod-link box under the user's cursor.
 *
 *  A stale cache can only ever cost one correction on the next paint, in the
 *  rare case an account's access changed since it was last read. */
const CACHE = "producer:flags";

function cached(): FlagState {
  try {
    const raw = localStorage.getItem(CACHE);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as { flags?: string[]; email?: string | null };
    return { flags: new Set((v.flags ?? []) as FeatureFlag[]), email: v.email ?? null, known: false };
  } catch {
    return EMPTY;
  }
}

function remember(s: FlagState) {
  try {
    localStorage.setItem(CACHE, JSON.stringify({ flags: [...s.flags], email: s.email }));
  } catch {
    /* private window, full disk — the next paint just resolves as before */
  }
}

export function useFeatureFlags(): FlagState {
  const [state, setState] = useState<FlagState>(cached);
  useEffect(() => {
    let alive = true;
    const read = () => {
      const ep = activeEndpointId();
      if (!ep) {
        // No workspace at all (a self-hosted room, a fresh install): gated,
        // and we KNOW it — this is an answer, not a pending state.
        if (alive) {
          const next = { flags: new Set<FeatureFlag>(), email: null, known: true };
          remember(next);
          setState(next);
        }
        return;
      }
      fetchMe(ep)
        .then((me) => {
          if (!alive) return;
          const next = { flags: flagsFor(me.email), email: me.email, known: true };
          remember(next);
          setState(next);
        })
        // Unreachable = gated. Fail closed.
        // Unreachable = gated. Fail closed — and remember that, so a machine
        // that keeps failing does not keep flashing the features on.
        .catch(() => {
          if (!alive) return;
          const next = { flags: new Set<FeatureFlag>(), email: null, known: true };
          remember(next);
          setState(next);
        });
    };
    read();
    window.addEventListener(WORKSPACE_EVENT, read);
    return () => {
      alive = false;
      window.removeEventListener(WORKSPACE_EVENT, read);
    };
  }, []);
  return state;
}

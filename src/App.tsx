import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { hasTauri, ipc, type EndpointInfo } from "./lib/ipc";
import { Onboarding, SignIn, Wordmark, hasSignedInBefore } from "./views/Onboarding";
import { ModSeat } from "./views/ModSeat";
import type { ModLink } from "./lib/modSeat";
import { setActiveEndpointId } from "./lib/workspace";
import { FirstLight, firstLightDone } from "./views/FirstLight";
import { Home } from "./views/Home";

type View = "loading" | "onboarding" | "signin" | "home" | { kind: "modseat"; link: ModLink; from: "onboarding" | "signin" };

function App() {
  const [view, setView] = useState<View>("loading");
  const [firstLight, setFirstLight] = useState(() => !firstLightDone());
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);

  const refresh = useCallback(async () => {
    // Browser preview has no Tauri bridge; render onboarding statically.
    if (!hasTauri()) {
      setView("onboarding");
      return;
    }
    try {
      const list = await ipc.listEndpoints();
      setEndpoints(list);
      // No workspaces: a machine that has signed in before gets the plain
      // sign-in screen; a fresh one gets the full front door.
      setView(list.length === 0 ? (hasSignedInBefore() ? "signin" : "onboarding") : "home");
    } catch {
      setView("onboarding");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function removeEndpoint(id: string) {
    await ipc.removeEndpoint(id);
    await refresh();
  }

  /** Sign out of Boomin: every connected workspace (and its keychain token)
   * goes; self-hosted endpoints are not Boomin's and stay. */
  async function signOut() {
    for (const e of endpoints.filter((x) => x.kind === "connected")) {
      await ipc.removeEndpoint(e.id).catch(() => {});
    }
    setActiveEndpointId(null);
    await refresh();
  }

  if (firstLight) {
    return <FirstLight onDone={() => setFirstLight(false)} />;
  }

  if (view === "loading") {
    return (
      <main className="shell">
        <div className="boot">
          <Wordmark />
        </div>
      </main>
    );
  }

  // A mod seat opened from the welcome screen: no workspace yet, the link is
  // the credential. Leaving returns to the door it came from.
  if (typeof view === "object" && view.kind === "modseat") {
    return <ModSeat link={view.link} onLeave={() => setView(view.from)} />;
  }

  if (view === "signin") {
    return (
      <main className="shell">
        <SignIn onConnected={refresh} onModLink={(link) => setView({ kind: "modseat", link, from: "signin" })} />
      </main>
    );
  }

  if (view === "onboarding") {
    return (
      <main className="shell">
        <Onboarding
          onConnected={refresh}
          onModLink={(link) => setView({ kind: "modseat", link, from: "onboarding" })}
          onCancel={endpoints.length > 0 ? () => setView("home") : undefined}
        />
      </main>
    );
  }

  return (
    <Home
      endpoints={endpoints}
      onAddEndpoint={() => setView("onboarding")}
      onRemoveEndpoint={removeEndpoint}
      onSignOut={signOut}
      onEndpointsChanged={() => void refresh()}
    />
  );
}

export default App;

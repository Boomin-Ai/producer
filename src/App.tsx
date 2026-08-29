import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { hasTauri, ipc, type EndpointInfo } from "./lib/ipc";
import { Onboarding, Wordmark } from "./views/Onboarding";
import { FirstLight, firstLightDone } from "./views/FirstLight";
import { Home } from "./views/Home";

type View = "loading" | "onboarding" | "home";

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
      setView(list.length === 0 ? "onboarding" : "home");
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

  if (view === "onboarding") {
    return (
      <main className="shell">
        <Onboarding
          onConnected={refresh}
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
    />
  );
}

export default App;

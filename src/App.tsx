import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface EndpointInfo {
  id: string;
  kind: "connected" | "independent";
  name: string;
  base_url: string;
  created_at: string;
}

type View = "loading" | "chooser" | "add-server" | "home";

function Wordmark() {
  return (
    <div className="wordmark">
      PRODUCER <span className="by">by Boomin</span>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("loading");
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Browser preview has no Tauri bridge; render the chooser statically.
    if (!("__TAURI_INTERNALS__" in window)) {
      setView("chooser");
      return;
    }
    try {
      const list = await invoke<EndpointInfo[]>("list_endpoints");
      setEndpoints(list);
      setView(list.length === 0 ? "chooser" : "home");
    } catch (e) {
      setError(String(e));
      setView("chooser");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addServer(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      await invoke("add_endpoint", {
        kind: "independent",
        name: String(form.get("name") || "My server"),
        baseUrl: String(form.get("base_url") || ""),
        token: String(form.get("token") || ""),
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeEndpoint(id: string) {
    try {
      await invoke("remove_endpoint", { endpointId: id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
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

  if (view === "chooser") {
    return (
      <main className="shell">
        <div className="onboarding">
          <Wordmark />
          <h1>
            <span>Stop posting.</span> <strong>Start producing.</strong>
          </h1>
          <div className="doors">
            <div className="door door-disabled">
              <h2>Connect with Boomin</h2>
              <p>
                Free account, posting in ~2 minutes. Your posts route
                through Boomin&rsquo;s servers.
              </p>
              <button disabled>Arrives in M2</button>
            </div>
            <div className="door">
              <h2>Use your own server</h2>
              <p>
                Deploy the open-source producer-server to your own
                Cloudflare account, then connect it here. Nothing
                touches Boomin, ever.
              </p>
              <button onClick={() => setView("add-server")}>
                Connect my server
              </button>
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <p className="status">v0.1.0-dev · open-source · cross-posting first</p>
        </div>
      </main>
    );
  }

  if (view === "add-server") {
    return (
      <main className="shell">
        <div className="onboarding">
          <Wordmark />
          <h1>
            <strong>Your server.</strong>
          </h1>
          <form
            className="server-form"
            onSubmit={(e) => {
              e.preventDefault();
              addServer(new FormData(e.currentTarget));
            }}
          >
            <label>
              Name
              <input name="name" placeholder="My producer-server" />
            </label>
            <label>
              Endpoint URL
              <input
                name="base_url"
                placeholder="https://producer.yourname.workers.dev"
                required
              />
            </label>
            <label>
              Access token
              <input
                name="token"
                type="password"
                placeholder="paste your endpoint token"
                required
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="form-actions">
              <button type="button" className="ghost" onClick={() => setView("chooser")}>
                Back
              </button>
              <button type="submit" disabled={busy}>
                {busy ? "Verifying…" : "Verify & connect"}
              </button>
            </div>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell-top">
      <div className="home">
        <header className="home-head">
          <Wordmark />
          <button className="ghost" onClick={() => setView("chooser")}>
            Add endpoint
          </button>
        </header>
        <h2 className="section-title">Endpoints</h2>
        <ul className="endpoint-list">
          {endpoints.map((ep) => (
            <li key={ep.id} className="endpoint">
              <div>
                <span className={`mode-badge ${ep.kind}`}>
                  {ep.kind === "connected" ? "Connected" : "Independent"}
                </span>
                <strong>{ep.name}</strong>
                <span className="endpoint-url">{ep.base_url}</span>
              </div>
              <button className="ghost" onClick={() => removeEndpoint(ep.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <p className="status">
          M1 skeleton — the composer arrives in M2. Your endpoint is
          verified and its access token is stored in the OS keychain.
        </p>
      </div>
    </main>
  );
}

export default App;

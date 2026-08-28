import { useState } from "react";
import { hasTauri, ipc } from "../lib/ipc";

export function Wordmark() {
  return (
    <div className="wordmark">
      PRODUCER <span className="by">by Boomin</span>
    </div>
  );
}

type Door = "chooser" | "boomin" | "server";

export function Onboarding({ onConnected }: { onConnected: () => void }) {
  const [door, setDoor] = useState<Door>("chooser");

  if (door === "boomin") return <BoominLogin onBack={() => setDoor("chooser")} onConnected={onConnected} />;
  if (door === "server") return <ServerForm onBack={() => setDoor("chooser")} onConnected={onConnected} />;

  return (
    <div className="onboarding">
      <Wordmark />
      <h1>
        <span>Stop posting.</span> <strong>Start producing.</strong>
      </h1>
      <div className="doors">
        <div className="door">
          <h2>Connect with Boomin</h2>
          <p>
            Free account, posting in ~2 minutes. Your posts route through
            Boomin&rsquo;s servers.
          </p>
          <button onClick={() => setDoor("boomin")} disabled={!hasTauri()}>
            {hasTauri() ? "Sign in with email" : "Open the desktop app"}
          </button>
        </div>
        <div className="door">
          <h2>Use your own server</h2>
          <p>
            Deploy the open-source producer-server to your own Cloudflare
            account, then connect it here. Nothing touches Boomin, ever.
          </p>
          <button onClick={() => setDoor("server")} disabled={!hasTauri()}>
            Connect my server
          </button>
        </div>
      </div>
      <p className="status">v0.1.0-dev · open-source · cross-posting first</p>
    </div>
  );
}

function BoominLogin({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [apiRoot, setApiRoot] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      await ipc.boominRequestOtp(email.trim(), apiRoot.trim() || undefined);
      setStep("code");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await ipc.boominConnect(email.trim(), code.trim(), apiRoot.trim() || undefined);
      onConnected();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <Wordmark />
      <h1>
        <strong>Sign in with Boomin.</strong>
      </h1>
      <form
        className="server-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === "email") requestCode();
          else verify();
        }}
      >
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={step === "code"}
            required
            autoFocus
          />
        </label>
        {step === "code" && (
          <label>
            Sign-in code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code from your email"
              inputMode="numeric"
              required
              autoFocus
            />
          </label>
        )}
        {showAdvanced ? (
          <label>
            API root (advanced)
            <input
              value={apiRoot}
              onChange={(e) => setApiRoot(e.target.value)}
              placeholder="https://api.boomin.ai"
            />
          </label>
        ) : (
          <button type="button" className="linkish" onClick={() => setShowAdvanced(true)}>
            Advanced: custom API root
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="ghost" onClick={step === "code" ? () => setStep("email") : onBack}>
            Back
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : step === "email" ? "Email me a code" : "Verify & connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ServerForm({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      await ipc.addEndpoint(
        "independent",
        String(form.get("name") || "My server"),
        String(form.get("base_url") || ""),
        String(form.get("token") || ""),
      );
      onConnected();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <Wordmark />
      <h1>
        <strong>Your server.</strong>
      </h1>
      <form
        className="server-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(new FormData(e.currentTarget));
        }}
      >
        <label>
          Name
          <input name="name" placeholder="My producer-server" />
        </label>
        <label>
          Endpoint URL
          <input name="base_url" placeholder="https://producer.yourname.workers.dev" required />
        </label>
        <label>
          Access token
          <input name="token" type="password" placeholder="paste your endpoint token" required />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="ghost" onClick={onBack}>
            Back
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Verify & connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

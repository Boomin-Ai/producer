import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasTauri, ipc, networkJoin, network } from "../lib/ipc";
import { setActiveEndpointId } from "../lib/workspace";
import { ModLinkDrop } from "./ModLinkDrop";
import type { ModLink } from "../lib/modSeat";

/** The self-hosting walkthrough — deploy the open producer-server, then
 * connect it here with its URL + PRIMARY_TOKEN. */
export const SELF_HOSTING_GUIDE_URL = "https://github.com/Boomin-Ai/producer/blob/main/server/SELF_HOSTING.md";

export function Wordmark() {
  return (
    <div className="wordmark">
      PRODUCER <span className="by">by Boomin</span>
    </div>
  );
}

type Door = "chooser" | "boomin" | "server";

/** Remembered once a Boomin account has connected on this machine, so an
 * empty endpoint list after that means "signed out", not "never seen". */
const SIGNED_IN_KEY = "producer.signedin.v1";
export function hasSignedInBefore(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberSignedIn() {
  try {
    localStorage.setItem(SIGNED_IN_KEY, "1");
  } catch {
    /* storage unavailable — the chooser shows next time, nothing worse */
  }
}

/** The sign-in screen: straight to email + code, no pitch, no network
 * opt-in — for someone who already knows the product (signed out, or a
 * returning machine). "Use my own server" is a first-class door beside it,
 * not a footnote: a self-hoster never needs a Boomin account to get in. */
export function SignIn({ onConnected, onModLink }: { onConnected: () => void; onModLink?: (link: ModLink) => void }) {
  const [door, setDoor] = useState<"boomin" | "server">("boomin");
  if (door === "server") return <ServerForm onBack={() => setDoor("boomin")} onConnected={onConnected} />;
  return (
    <BoominLogin
      direct
      onBack={() => setDoor("server")}
      backLabel="Use my own server"
      onConnected={onConnected}
      onModLink={onModLink}
    />
  );
}

export function Onboarding({ onConnected, onCancel, onModLink }: { onConnected: () => void; onCancel?: () => void; onModLink?: (link: ModLink) => void }) {
  const [door, setDoor] = useState<Door>("chooser");

  if (door === "boomin") return <BoominLogin onBack={() => setDoor("chooser")} onConnected={onConnected} />;
  if (door === "server") return <ServerForm onBack={() => setDoor("chooser")} onConnected={onConnected} />;

  return (
    <div className="onboarding">
      {onCancel && (
        <button className="cr-back onboarding-cancel" onClick={onCancel} title="Back to the control room">
          ✕
        </button>
      )}
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
      {/* The third door: no account anywhere, just a link someone sent you.
        * A mod seat needs neither Boomin nor a server of your own. */}
      {onModLink && (
        <div className="onboarding-modlink">
          <span>Helping run someone else&rsquo;s show?</span>
          <ModLinkDrop compact onOpen={onModLink} />
        </div>
      )}
      <p className="status">v0.1.0-dev · open-source · cross-posting first</p>
    </div>
  );
}

function BoominLogin({
  onBack,
  onConnected,
  direct = false,
  backLabel = "Back",
  onModLink,
}: {
  onBack: () => void;
  onConnected: () => void;
  /** Sign-in mode: skip the network opt-in step — you're coming back, not
   *  joining. */
  direct?: boolean;
  backLabel?: string;
  onModLink?: (link: ModLink) => void;
}) {
  const [step, setStep] = useState<"email" | "code" | "brand" | "network">("email");
  // Opt-in, and OFF by default: a network listing is a public projection of
  // the brand, so it should never happen because someone clicked through.
  const [joinNetwork, setJoinNetwork] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [apiRoot, setApiRoot] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The opt-in is for brands that have never answered the question. A brand
   *  that is already in (active), was invited, or deliberately left must not be
   *  asked again — re-listing a brand is never a side effect of signing in.
   *  If the status call fails we still ask: the box is off by default, so the
   *  worst case is one extra screen, never a silent join. */
  async function needsNetworkStep(endpointId?: string | null): Promise<boolean> {
    try {
      let id = endpointId ?? null;
      if (!id) {
        const eps = await ipc.listEndpoints();
        id = (eps.find((e) => e.kind === "connected") ?? eps[0])?.id ?? null;
      }
      if (!id) return true;
      const st = await network.status(id);
      return !st?.membership?.status;
    } catch {
      return true;
    }
  }

  async function goAfterConnect(endpointId?: string | null) {
    if (direct || !(await needsNetworkStep(endpointId))) onConnected();
    else setStep("network");
  }

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
      const result = await ipc.boominConnect(email.trim(), code.trim(), apiRoot.trim() || undefined);
      rememberSignedIn();
      // The workspace just connected becomes the active one.
      if ((result as { id?: string } | null)?.id) setActiveEndpointId(String((result as { id?: string }).id));
      if (result?.needs_brand && result.brands?.length) {
        setBrands(result.brands);
        setStep("brand");
      } else {
        await goAfterConnect((result as { id?: string } | null)?.id ?? null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickBrand(slug: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await ipc.boominSelectBrand(slug);
      if (r?.id) setActiveEndpointId(r.id);
      await goAfterConnect(r?.id ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === "network") {
    const finish = async () => {
      setBusy(true);
      if (joinNetwork) {
        try {
          // Best-effort: joining must never block getting into the app. If
          // the call fails the user is connected anyway and can join later.
          const eps = await ipc.listEndpoints();
          const ep = eps.find((e) => e.kind === "connected") ?? eps[0];
          if (ep) await networkJoin(ep.id);
        } catch {
          /* surfaced later in settings, never a blocker here */
        }
      }
      setBusy(false);
      onConnected();
    };
    return (
      <div className="onboarding">
        <Wordmark />
        <h1>
          <strong>Join the Brand Network?</strong>
        </h1>
        <p className="muted">
          Optional, and free. You can change this any time.
        </p>
        <div
          className={`net-optin${joinNetwork ? " on" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => setJoinNetwork((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setJoinNetwork((v) => !v);
            }
          }}
        >
          <span className={`net-box${joinNetwork ? " on" : ""}`}>{joinNetwork ? "✓" : ""}</span>
          <span className="net-text">
            <span className="net-title">Join the Brand Network</span>
            <span className="net-detail">
              Your brand becomes discoverable, and open to guest appearances, brand deals
              and content collaboration.
            </span>
          </span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions" style={{ justifyContent: "center", marginTop: 18 }}>
          <button type="button" className="primary" disabled={busy} onClick={finish}>
            {busy ? "Finishing…" : joinNetwork ? "Join and continue" : "Continue"}
          </button>
        </div>
      </div>
    );
  }

  if (step === "brand") {
    return (
      <div className="onboarding">
        <Wordmark />
        <h1>
          <strong>Which workspace?</strong>
        </h1>
        <p className="muted">
          This account has several brands — pick the one to open first. The
          others are one click away in the workspace switcher.
        </p>
        <div className="brand-list">
          {brands.map((b) => (
            <button key={b.slug} className="brand-option" disabled={busy} onClick={() => pickBrand(b.slug)}>
              {b.name}
              <span className="muted">{b.slug}</span>
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions" style={{ justifyContent: "center", marginTop: 16 }}>
          <button type="button" className="ghost" onClick={onBack}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <Wordmark />
      <h1>
        <strong>{direct ? "Welcome back." : "Sign in with Boomin."}</strong>
      </h1>
      {direct && <p className="muted">Sign in with the email on your Boomin account.</p>}
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
            {step === "code" ? "Back" : backLabel}
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : step === "email" ? "Email me a code" : "Verify & connect"}
          </button>
        </div>
      </form>
      {direct && (
        <div className="signin-doors">
          <span>Running your own producer-server?</span>
          <button type="button" className="linkish" onClick={onBack}>
            Use my own server
          </button>
          <span className="sep">·</span>
          <button type="button" className="linkish" onClick={() => openUrl(SELF_HOSTING_GUIDE_URL).catch(() => {})}>
            Self-hosting guide
          </button>
        </div>
      )}
      {direct && onModLink && (
        <div className="onboarding-modlink">
          <span>Helping run someone else&rsquo;s show?</span>
          <ModLinkDrop compact onOpen={onModLink} />
        </div>
      )}
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
      <p className="muted">
        Shows, rooms and guests all run on your own producer-server. Nothing touches Boomin.
      </p>
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
          Server URL
          <input name="base_url" placeholder="https://producer-server.yourname.workers.dev" required />
        </label>
        <p className="hint">The worker URL wrangler printed when you deployed.</p>
        <label>
          Primary token
          <input name="token" type="password" placeholder="the PRIMARY_TOKEN you set on the server" required />
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
      <div className="signin-doors">
        <span>Haven&rsquo;t deployed one yet?</span>
        <button type="button" className="linkish" onClick={() => openUrl(SELF_HOSTING_GUIDE_URL).catch(() => {})}>
          Self-hosting guide
        </button>
      </div>
    </div>
  );
}

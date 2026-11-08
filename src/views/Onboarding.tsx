import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasTauri, ipc, networkJoin, network } from "../lib/ipc";
import { setActiveEndpointId } from "../lib/workspace";
import { ModLinkDrop } from "./ModLinkDrop";
import type { ModLink } from "../lib/modSeat";

/** The self-hosting walkthrough — deploy the open producer-server, then
 * connect it here with its URL + PRIMARY_TOKEN. */
export const SELF_HOSTING_GUIDE_URL = "https://github.com/Boomin-Ai/producer/blob/main/server/SELF_HOSTING.md";
export const BOOMIN_SIGNUP_URL = "https://boomin.ai/signup";

/** The name, with where it stands. `big` is the first-impression form
 *  (sign-in, first run); everywhere else it is the same mark at a quieter
 *  size.
 *
 *  BETA rides along in a lighter weight and a quieter colour: it is a
 *  qualifier on the name, not part of it, and setting it in the same bold
 *  caps would read as "Producer Beta" — a product with that name. Thin, so
 *  the eye takes the name first and the status second. */
export function Wordmark({ big = false }: { big?: boolean }) {
  return (
    <div className={`wordmark${big ? " big" : ""}`}>
      PRODUCER<span className="wordmark-beta">BETA</span>
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

/** Returning beta users sign in with Boomin. Connecting another owned server
 * remains available from an existing workspace, not the initial welcome. */
export function SignIn({ onConnected, onModLink, allowServerConnection = false }: { onConnected: () => void; onModLink?: (link: ModLink) => void; allowServerConnection?: boolean }) {
  const [door, setDoor] = useState<"boomin" | "server">("boomin");
  if (allowServerConnection && door === "server") return <ServerForm onBack={() => setDoor("boomin")} onConnected={onConnected} />;
  return (
    <BoominLogin
      direct
      betaRequired={!allowServerConnection}
      onBack={allowServerConnection ? () => setDoor("server") : undefined}
      backLabel="Use my own server"
      onConnected={onConnected}
      onModLink={onModLink}
    />
  );
}

export function Onboarding({ onConnected, onCancel, onModLink, start, allowServerConnection = false }: { onConnected: () => void; onCancel?: () => void; onModLink?: (link: ModLink) => void; start?: "server"; allowServerConnection?: boolean }) {
  const [door, setDoor] = useState<Door>(start ?? "chooser");

  if (!allowServerConnection) return <BoominLogin betaRequired onConnected={onConnected} onModLink={onModLink} />;
  if (door === "boomin") return <BoominLogin onBack={() => setDoor("chooser")} onConnected={onConnected} onModLink={onModLink} />;
  // Arriving straight on the server form (the account sheet's "Connect a
  // server") means there is no chooser behind it — Back returns to where the
  // click came from, the dashboard.
  if (door === "server")
    return (
      <ServerForm
        onBack={start === "server" && onCancel ? onCancel : () => setDoor("chooser")}
        backLabel={start === "server" && onCancel ? "Back" : undefined}
        onConnected={onConnected}
      />
    );

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
  betaRequired = false,
  backLabel = "Back",
  onModLink,
}: {
  onBack?: () => void;
  onConnected: () => void;
  /** Sign-in mode: skip the network opt-in step — you're coming back, not
   *  joining. */
  direct?: boolean;
  /** The beta's primary workspace entry requires Boomin; invitation seats
   * still use their own capability and existing connections are preserved. */
  betaRequired?: boolean;
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
  /** The mod-link door is a disclosure, not a third input competing with the
   *  email field: one thing to do on this screen, the rest one click away. */
  const [modOpen, setModOpen] = useState(false);
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
      await ipc.boominRequestOtp(email.trim(), betaRequired ? undefined : apiRoot.trim() || undefined);
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
      const result = await ipc.boominConnect(email.trim(), code.trim(), betaRequired ? undefined : apiRoot.trim() || undefined);
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
          <button type="button" className="ghost" onClick={onBack ?? (() => setStep("email"))}>
            {onBack ? "Cancel" : "Use a different email"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`onboarding${direct ? " signin" : ""}`}>
      <Wordmark big />
      <h1>
        <strong>{betaRequired && !direct ? "Start with Boomin." : direct ? "Welcome back." : "Sign in with Boomin."}</strong>
      </h1>
      {betaRequired ? <p className="muted">New installations require a Boomin account during the beta. Sign in with your Boomin email, or set up an account and workspace first.</p> : direct && <p className="muted">Sign in with the email on your Boomin account.</p>}
      <form
        className="server-form signin-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!hasTauri()) return;
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
        {showAdvanced && !betaRequired && (
          <label>
            API root (advanced)
            <input
              value={apiRoot}
              onChange={(e) => setApiRoot(e.target.value)}
              placeholder="https://api.boomin.ai"
            />
          </label>
        )}
        {!showAdvanced && !direct && !betaRequired && (
          <button type="button" className="linkish" onClick={() => setShowAdvanced(true)}>
            Advanced: custom API root
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {/* One primary, full width: the email step has exactly one thing to do.
          * Every other door lives in the quiet list below the card. */}
        {direct && step === "email" ? (
          <button type="submit" className="signin-go" disabled={busy || !hasTauri()}>
            {!hasTauri() ? "Open the desktop app" : busy ? "Working…" : "Email me a code"}
          </button>
        ) : (
          <div className="form-actions">
            {(step === "code" || onBack) && <button type="button" className="ghost" onClick={step === "code" ? () => setStep("email") : onBack}>
              {step === "code" ? "Back" : backLabel}
            </button>}
            <button type="submit" disabled={busy || !hasTauri()}>
              {!hasTauri() ? "Open the desktop app" : busy ? "Working…" : step === "email" ? "Email me a code" : "Verify & connect"}
            </button>
          </div>
        )}
      </form>
      {(direct || betaRequired) && (
        <>
          <div className="signin-or"><span>or</span></div>
          <div className="signin-alt">
            {betaRequired && <button type="button" className="signin-alt-row" onClick={() => openUrl(BOOMIN_SIGNUP_URL).catch(() => setError("Could not open Boomin. Visit boomin.ai/signup to set up your account and workspace, then return here."))}>
              <span className="signin-alt-t">Create a Boomin account</span>
              <span className="signin-alt-s">Set up your workspace on boomin.ai, then sign in here</span>
            </button>}
            {!betaRequired && onBack && <button type="button" className="signin-alt-row" onClick={onBack}>
              <span className="signin-alt-t">Use my own server</span>
              <span className="signin-alt-s">Run producer-server yourself — nothing touches Boomin</span>
            </button>}
            {onModLink && (
              <div className={`signin-alt-row static${modOpen ? " open" : ""}`}>
                <button type="button" className="signin-alt-head" onClick={() => setModOpen((v) => !v)}>
                  <span className="signin-alt-t">Open a mod link</span>
                  <span className="signin-alt-s">Someone sent you a seat — no account needed</span>
                </button>
                {modOpen && <ModLinkDrop compact onOpen={onModLink} />}
              </div>
            )}
          </div>
          {!betaRequired && <div className="signin-foot">
            <button type="button" className="linkish" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </button>
            <span className="sep">·</span>
            <button type="button" className="linkish" onClick={() => openUrl(SELF_HOSTING_GUIDE_URL).catch(() => {})}>
              Self-hosting guide
            </button>
          </div>}
        </>
      )}
    </div>
  );
}

function ServerForm({ onBack, onConnected, backLabel = "Back" }: { onBack: () => void; onConnected: () => void; backLabel?: string }) {
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
            {backLabel}
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

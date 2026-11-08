import { useId, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasTauri, ipc, networkJoin, network } from "../lib/ipc";
import { setActiveEndpointId } from "../lib/workspace";
import { ModLinkDrop } from "./ModLinkDrop";
import type { ModLink } from "../lib/modSeat";
import { EntryFrame } from "./EntryFrame";

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
    <EntryFrame>
      {onCancel && (
        <button type="button" className="entry-text-button entry-back" onClick={onCancel} title="Back to the control room">
          ← Back
        </button>
      )}
      <h1 className="entry-heading">Add a workspace</h1>
      <p className="entry-description">Connect with Boomin or add a server you own.</p>
      <div className="doors">
        <div className="door">
          <h2>Connect with Boomin</h2>
          <p>
            Sign in to your Boomin workspace.
          </p>
          <button onClick={() => setDoor("boomin")} disabled={!hasTauri()}>
            {hasTauri() ? "Sign in with email" : "Open the desktop app"}
          </button>
        </div>
        <div className="door">
          <h2>Use your own server</h2>
          <p>
            Connect an existing producer-server.
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
    </EntryFrame>
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
  const [connectedEndpointId, setConnectedEndpointId] = useState<string | null>(null);
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
  const errorId = useId();
  const modId = useId();

  function backToEmail() {
    if (busy) return;
    setCode("");
    setError(null);
    setStep("email");
  }

  /** The opt-in is for brands that have never answered the question. A brand
   *  that is already in (active), was invited, or deliberately left must not be
   *  asked again — re-listing a brand is never a side effect of signing in.
   *  If the status call fails we still ask: the box is off by default, so the
   *  worst case is one extra screen, never a silent join. */
  async function needsNetworkStep(endpointId: string): Promise<boolean> {
    try {
      const st = await network.status(endpointId);
      return !st?.membership?.status;
    } catch {
      return true;
    }
  }

  async function goAfterConnect(endpointId?: string | null) {
    const id = endpointId ?? null;
    setConnectedEndpointId(id);
    // Older engines may omit the ID. Never list an arbitrary saved workspace.
    if (direct || !id || !(await needsNetworkStep(id))) onConnected();
    else setStep("network");
  }

  async function requestCode() {
    if (busy) return;
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
    if (busy) return;
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
    if (busy) return;
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
      if (busy) return;
      setBusy(true);
      if (joinNetwork && connectedEndpointId) {
        try {
          // Best-effort: joining must never block getting into the app. If
          // the call fails the user is connected anyway and can join later.
          await networkJoin(connectedEndpointId);
        } catch {
          /* surfaced later in settings, never a blocker here */
        }
      }
      setBusy(false);
      onConnected();
    };
    return (
      <EntryFrame>
        <h1 className="entry-heading">Meet your network</h1>
        <p className="entry-description">Make your workspace discoverable on the Boomin Network. This is optional.</p>
        <label className="entry-optin">
          <input type="checkbox" checked={joinNetwork} disabled={busy} autoFocus onChange={event => setJoinNetwork(event.target.checked)} />
          <span>
            <strong>List my workspace on Boomin</strong>
            <small>Be discovered for guest appearances, collaborations and brand deals. You can change this in Settings.</small>
          </span>
        </label>
        {error && <p className="entry-error" role="alert">{error}</p>}
        <div className="entry-actions">
          <button type="button" className="entry-primary" disabled={busy} onClick={finish}>
            {busy ? "Finishing…" : joinNetwork ? "Join and continue" : "Continue"}
          </button>
        </div>
      </EntryFrame>
    );
  }

  if (step === "brand") {
    return (
      <EntryFrame>
        <h1 className="entry-heading">Choose a workspace</h1>
        <p className="entry-description">Choose where to start. You can switch workspaces anytime.</p>
        <div className="entry-brand-list" aria-label="Your workspaces" aria-busy={busy}>
          {brands.map((b, index) => (
            <button key={b.slug} className="entry-brand-option" disabled={busy} autoFocus={index === 0} onClick={() => pickBrand(b.slug)}>
              <span className="entry-brand-avatar" aria-hidden="true">{b.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{b.name}</strong><small>@{b.slug}</small></span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        {error && <p className="entry-error" role="alert">{error}</p>}
        <div className="entry-actions">
          <button type="button" className="entry-text-button" disabled={busy} onClick={onBack ?? backToEmail}>
            {onBack ? "Cancel" : "Use a different email"}
          </button>
        </div>
      </EntryFrame>
    );
  }

  return (
    <EntryFrame>
      <h1 className="entry-heading">{step === "code" ? "Check your inbox" : direct ? "Welcome back" : "Sign in to Producer"}</h1>
      <p className="entry-description">{step === "code" ? <>Enter the sign-in code sent to <strong>{email.trim()}</strong>.</> : "Use your Boomin email to open your workspace."}</p>
      <form
        className="entry-form"
        aria-busy={busy}
        aria-describedby={error ? errorId : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (!hasTauri() || busy) return;
          if (step === "email") requestCode();
          else verify();
        }}
      >
        <label hidden={step === "code"}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={step === "code" || busy}
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
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
              autoComplete="one-time-code"
              className="entry-code"
              maxLength={6}
              pattern="[0-9]{6}"
              disabled={busy}
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
        {error && <p id={errorId} className="entry-error" role="alert">{error}</p>}
          <div className="entry-form-actions">
            <button type="submit" disabled={busy || !hasTauri()}>
              {!hasTauri() ? "Open the desktop app" : busy ? step === "email" ? "Sending code…" : "Signing in…" : step === "email" ? "Email me a code" : "Verify & connect"}
            </button>
            {(step === "code" || onBack) && <button type="button" className="entry-secondary" disabled={busy} onClick={step === "code" ? backToEmail : onBack}>
              {step === "code" ? "Back" : backLabel}
            </button>}
          </div>
      </form>
      {betaRequired && <p className="entry-beta-note"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="6" width="14" height="11" rx="3" /><path d="M6 6V4a4 4 0 0 1 8 0v2M10 10v3" /></svg>Producer beta requires a Boomin account and workspace.</p>}
      {(direct || betaRequired) && (
        <>
          <div className="entry-account">
            {betaRequired && <>New to Boomin? <button type="button" disabled={busy} onClick={() => openUrl(BOOMIN_SIGNUP_URL).catch(() => setError("Could not open Boomin. Visit boomin.ai/signup to set up your account and workspace, then return here."))}>Create a Boomin account <span aria-hidden="true">↗</span></button></>}
            {!betaRequired && onBack && <button type="button" disabled={busy} onClick={onBack}>Use my own server</button>}
          </div>
            {onModLink && (
              <div className="entry-invitation">
                <button type="button" disabled={busy} aria-expanded={modOpen} aria-controls={modId} onClick={() => setModOpen((v) => !v)}>
                  <span aria-hidden="true">›</span>Open a mod link
                </button>
                {modOpen && <fieldset id={modId} disabled={busy} className="entry-invitation-fields"><p className="entry-note">Join with the invitation you received.</p><ModLinkDrop compact onOpen={link => { if (!busy) onModLink(link); }} /></fieldset>}
              </div>
            )}
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
    </EntryFrame>
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
    <EntryFrame>
      <h1 className="entry-heading">Connect your server</h1>
      <p className="entry-description">Enter your producer-server address and primary token.</p>
      <form
        className="entry-form"
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
        <label>
          Primary token
          <input name="token" type="password" placeholder="the PRIMARY_TOKEN you set on the server" required />
        </label>
        {error && <p className="entry-error" role="alert">{error}</p>}
        <div className="entry-form-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Verify & connect"}
          </button>
          <button type="button" className="entry-secondary" disabled={busy} onClick={onBack}>
            {backLabel}
          </button>
        </div>
      </form>
      <div className="signin-doors">
        <span>Haven&rsquo;t deployed one yet?</span>
        <button type="button" className="linkish" onClick={() => openUrl(SELF_HOSTING_GUIDE_URL).catch(() => {})}>
          Self-hosting guide
        </button>
      </div>
    </EntryFrame>
  );
}

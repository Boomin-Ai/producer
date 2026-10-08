import { useEffect, useState } from "react";
import { Select } from "./Select";
import { ipc } from "../lib/ipc";
import { prefGet, PREFS_EVENT } from "../lib/prefs";
import { DEFAULT_SHARE_DOMAIN, PREF_SHARE_DOMAIN, shareDomain, type ShareDomain } from "../lib/shareDomain";

export function ShareDomainSettings() {
  const [domain, setDomain] = useState<ShareDomain>(DEFAULT_SHARE_DOMAIN);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; void prefGet(PREF_SHARE_DOMAIN).then(value => { if (alive) { setDomain(shareDomain(value)); setLoaded(true); } }); return () => { alive = false; }; }, []);
  const save = async (value: string) => {
    setSaving(true); setError(null);
    try {
      const next = shareDomain(value);
      await ipc.prefSet(PREF_SHARE_DOMAIN, next);
      setDomain(next);
      window.dispatchEvent(new Event(PREFS_EVENT));
    } catch { setError("Could not save the link domain. Try again."); }
    finally { setSaving(false); }
  };
  return <>
    <div className="cr-label set-gap">SHARE LINKS</div>
    <div className="set-list">
      <div className="cr-sheet-row">
        <span className="cr-sheet-row-name">Link domain</span>
        <span className="cr-sheet-row-sub">Audience and guest links for rooms on the Boomin network</span>
        <Select value={domain} options={[{ value: "producer.dev", label: "producer.dev", hint: "Default" }, { value: "boomin.ai", label: "boomin.ai" }]} onChange={value => void save(value)} disabled={!loaded || saving} aria-label="Share link domain" />
      </div>
      <div className="cr-hint">Both domains open the same room. Previously shared links keep working.</div>
      {error && <div className="cr-hint" role="alert">{error}</div>}
    </div>
  </>;
}

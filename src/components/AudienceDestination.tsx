import boominLogo from '../assets/boomin-channel.png';
import './AudienceDestination.css';

export function AudienceDestinationMark() {
  return <img className="aud-destination-mark" src={boominLogo} alt="" />;
}

/** This destination opens the room's audience link; it is not an RTMP output. */
export function AudienceDestination({ enabled, available, hosted, compact = false, onChange }: {
  enabled: boolean;
  available: boolean;
  hosted: boolean;
  compact?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const name = hosted ? 'Boomin' : 'Audience';
  const description = enabled ? 'Audience link open' : 'Audience link closed';
  const hint = available
    ? `${name} — ${description}. Open the audience link without starting an external stream.`
    : 'Connect to this room as its host to change audience access.';
  if (compact) return <button type="button" className={`chn-ico aud-destination-tile${enabled ? ' on' : ''}`} aria-label={`${name} audience access`} aria-pressed={enabled} disabled={!available} title={hint} onClick={() => onChange(!enabled)}>
    <AudienceDestinationMark />
    <span className="aud-destination-short">{name}</span>
    <span className="chn-ico-txt"><b>{name}</b><i>{enabled ? 'Open' : 'Closed'}</i></span>
  </button>;
  return <label className="chn-row aud-destination-row" title={hint}>
    <span className="chn-logo"><AudienceDestinationMark /></span>
    <span className="aud-destination-copy"><span className="chn-name">{name}</span><small>{description}</small></span>
    <input type="checkbox" aria-label={`${name} audience access`} checked={enabled} disabled={!available} onChange={event => onChange(event.target.checked)} />
  </label>;
}

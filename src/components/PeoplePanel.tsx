import { useId, useState, type ReactNode } from 'react';
import { AudiencePanel, AudienceHands, type AudiencePanelProps } from './AudiencePanel';
import './PeoplePanel.css';

/** Keeps audience delivery separate from incoming guest media, in one dock.
 * Stable host panel ID is `guests`; compact docks open the same join controls. */
export function PeoplePanel({ audience, children, guestCount, waitingCount, onCopyGuestLink, compact = false }: {
  audience: AudiencePanelProps; children: ReactNode; guestCount: number; waitingCount: number;
  onCopyGuestLink?: () => void; compact?: boolean;
}) {
  const linksId = useId();
  const requestsId = useId();
  const guestHelpId = useId();
  const [guestHelpOpen, setGuestHelpOpen] = useState(false);
  const links = <div className="people-join-content">
    <section className="people-guest-link" aria-label="Guest invite">
      <div className="people-section-head"><strong>Guest invite</strong>
        <button className="people-link-help" type="button" aria-label="What is a guest invite?" aria-expanded={guestHelpOpen} aria-controls={guestHelpId} onClick={() => setGuestHelpOpen(open => !open)}>?</button></div>
      <p>Join backstage with camera &amp; mic.</p>
      {guestHelpOpen && <p className="people-link-help-text" id={guestHelpId}>Guests join backstage with camera and microphone. The host chooses when their media appears on the room, set or show output.</p>}
      {onCopyGuestLink && <button className="people-copy-guest" type="button" aria-label="Copy guest link" onClick={onCopyGuestLink}>Copy link</button>}
      {!onCopyGuestLink && <p>Ask the host for a guest invitation.</p>}
    </section>
    <AudiencePanel {...audience} compact={false} showHands={false} />
  </div>;
  const requests = <AudienceHands {...audience} canInvite={audience.controls !== false && audience.canInvite !== false}
    canModerate={audience.controls !== false && audience.canModerate !== false} />;
  return <div className={`people-panel${compact ? ' is-compact' : ''}`}>
    {compact ? <>
      <div className="people-mini-actions">
        <button type="button" popoverTarget={linksId}>Join links</button>
        <span>{audience.state.online ?? 0} audience</span>
        <button type="button" popoverTarget={requestsId}>Requests · {audience.hands.length}</button>
      </div>
      <div id={linksId} popover="auto" className="people-popover" aria-label="Join links">{links}</div>
      <div id={requestsId} popover="auto" className="people-popover" aria-label="Stage requests">{requests}</div>
      <div className="people-roster">{children}</div>
    </> : <>
      <details className="people-join">
        <summary><strong>Join links</strong><span>{audience.state.online ?? 0} audience</span></summary>
        {links}
      </details>
      <div className="people-requests">{requests}</div>
      <section className="people-guests" aria-label="Guests">
        <div className="people-section-head"><strong>Guests</strong><span>{guestCount}/8 admitted{waitingCount ? ` · ${waitingCount} waiting` : ''}</span></div>
        <div className="people-roster">{children}</div>
      </section>
    </>}
  </div>;
}

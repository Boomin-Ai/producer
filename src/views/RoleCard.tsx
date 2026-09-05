// WHAT YOU ARE HERE. One small glass card, the same on a Boomin room, a
// self-hosted room and an open-server mod seat: the role in words, how it
// was earned, and its capabilities as quiet chips. The DTO it renders is the
// one the guards read (lib/participants.ts `roomAccessFrom`), so the card and
// the gates can never disagree.
import { roleChips, roleTitle, type RoomAccessInfo } from "../lib/participants";

export function RoleCard({
  access,
  host,
  compact = false,
  pending = false,
}: {
  access: RoomAccessInfo;
  /** The open server's host, for a mod seat ("Mod seat on studio.example"). */
  host?: string | null;
  /** Header size: one line, chips inline. */
  compact?: boolean;
  /** The route hasn't answered yet — say so rather than claim host. */
  pending?: boolean;
}) {
  const chips = roleChips(access);
  const title = pending ? "Checking your seat…" : roleTitle(access, host);
  return (
    <div
      className={`role-card role-${access.role}${compact ? " compact" : ""}${pending ? " pending" : ""}`}
      title={access.known ? `Your standing in this room, as the server reports it.` : "This server has no access route — the primary token is the host."}
    >
      <span className="role-card-title">{title}</span>
      {!pending && chips.length > 0 && (
        <span className="role-card-chips">
          {chips.map((c) => (
            <span key={c} className="role-chip">{c}</span>
          ))}
        </span>
      )}
    </div>
  );
}

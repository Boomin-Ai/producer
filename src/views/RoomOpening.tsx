export function RoomOpening({
  name,
  status = "Preparing the stage…",
  onLeave,
}: {
  name?: string;
  status?: string;
  onLeave?: () => void;
}) {
  return (
    <div className="rm-veil rm-opening">
      <header className="rm-opening-header" data-tauri-drag-region>
        {onLeave && (
          <button type="button" className="rm-opening-back" onClick={onLeave}>
            Back to rooms
          </button>
        )}
        <strong>{name ?? "Room"}</strong>
      </header>
      <div className="rm-opening-stage" role="status">
        <span className="rm-veil-spin" aria-hidden="true" />
        <span className="rm-veil-note">{status}</span>
      </div>
    </div>
  );
}

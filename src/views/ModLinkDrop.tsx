import { useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { parseModLink, type ModLink } from "../lib/modSeat";

/** A place to DROP a mod link. Someone else's server hands out
 * `https://their-server/connect/mod/gm_…`; pasting it here opens a mod seat
 * against THAT server, with no account on it and no token — the code in the
 * link is the credential. Lives on the welcome screen (a fresh install can
 * help run a show before it belongs to any workspace) and above the Network
 * rail at home. */
export function ModLinkDrop({ onOpen, compact = false }: { onOpen: (link: ModLink) => void; compact?: boolean }) {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  const [over, setOver] = useState(false);

  const take = (raw: string): boolean => {
    const link = parseModLink(raw);
    if (!link) {
      setBad(true);
      window.setTimeout(() => setBad(false), 1600);
      return false;
    }
    setValue("");
    onOpen(link);
    return true;
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (take(text)) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim()) take(value);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text"));
  };

  return (
    <div
      className={`modlink-drop${compact ? " compact" : ""}${over ? " over" : ""}${bad ? " bad" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {!compact && <div className="modlink-drop-k">MOD LINK</div>}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKey}
        placeholder={bad ? "That isn't a mod link" : "Drop a mod link to help run a show…"}
        spellCheck={false}
        aria-label="Mod link"
      />
    </div>
  );
}

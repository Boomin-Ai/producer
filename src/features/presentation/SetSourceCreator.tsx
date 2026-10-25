import { useEffect, useState } from "react";
import { devices, extraSources, type DeviceOption } from "../../lib/ipc";
import type { ExtraSpec } from "../../lib/sourceSpec";
export function SetSourceCreator({
  slot,
  label,
  create,
}: {
  slot: string;
  label: string;
  create: (slot: string, spec: ExtraSpec, label: string) => Promise<string|void>;
}) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState("camera"),
    [device, setDevice] = useState(""),
    [choices, setChoices] = useState<DeviceOption[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open || !["camera", "screen"].includes(kind)) return;
    let cancelled = false;
    setChoices([]);
    void devices.list(kind).then(
      (list) => {
        if (!cancelled) setChoices(list);
      },
      (e) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, open]);
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      let spec: ExtraSpec;
      if (kind === "camera")
        spec = { kind: "camera", ...(device ? { device } : {}) };
      else if (kind === "screen")
        spec = { kind: "screen", ...(device ? { display: device } : {}) };
      else if (kind === "color") spec = { kind: "color", color: "#20364d" };
      else {
        const file = await extraSources.pickFile(kind as "image" | "media");
        if (!file) return;
        spec =
          kind === "image"
            ? { kind: "image", path: file }
            : { kind: "media", path: file, looping: true };
      }
      await create(slot, spec, `${label} ${kind === "media" ? "video" : kind}`);
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        className="set-add-source"
        onClick={() => setOpen(true)}
      >
        Add source here
      </button>
    );
  return (
    <div className="set-source-create">
      <label>
        New source
        <select
          aria-label={`${label} new source type`}
          value={kind}
          disabled={busy}
          onChange={(e) => {
            setKind(e.target.value);
            setDevice("");
            setError("");
          }}
        >
          <option value="camera">Camera</option>
          <option value="screen">Screen</option>
          <option value="image">Image</option>
          <option value="media">Video</option>
          <option value="color">Color</option>
        </select>
      </label>
      {["camera", "screen"].includes(kind) && (
        <label>
          Device
          <select
            aria-label={`${label} new source device`}
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">
              Default {kind === "screen" ? "display" : "camera"}
            </option>
            {choices.map((d) => (
              <option key={d.id} value={d.id} disabled={d.disabled}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="set-source-create-actions">
        <button disabled={busy} onClick={() => void add()}>
          {busy ? "Adding…" : "Add and assign"}
        </button>
        <button disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="set-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

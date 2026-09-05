/** The green room — a Producer room in GUEST mode.
 *
 * The room view is the guest's own stage (their scene is their camera); this
 * strip above it is the seat: self-view, the host's program return once it
 * arrives, and one line of truth about where they are — waiting for the
 * host, connecting, in the room. They can stay here as long as they like.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GuestSeat, type GuestSeatSpec, type SeatState } from "../lib/guestSeat";

/** One seat per mounted view; created on mount, left on unmount. */
export function useGuestSeat(spec: GuestSeatSpec | undefined, camLabel?: string | null): GuestSeat | null {
  const [seat, setSeat] = useState<GuestSeat | null>(null);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!spec) return;
    const key = spec.joinUrl;
    if (started.current === key) return;
    started.current = key;
    const s = new GuestSeat({ ...spec, camLabel: spec.camLabel ?? camLabel ?? null });
    setSeat(s);
    void s.start();
    return () => {
      s.leave();
      started.current = null;
      setSeat(null);
    };
    // camLabel is read once, when the seat opens its camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.joinUrl]);
  return seat;
}

function useSeatState(seat: GuestSeat | null): SeatState | null {
  return useSyncExternalStore(
    (fn) => (seat ? seat.subscribe(fn) : () => {}),
    () => (seat ? seat.snapshot() : null),
    () => null,
  );
}

function Stream({ stream, className, muted }: { stream: MediaStream | null; className: string; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function HostAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (a.srcObject !== stream) a.srcObject = stream;
    if (stream) void a.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

export function GreenRoomBar({ seat, spec, onLeave }: { seat: GuestSeat | null; spec: GuestSeatSpec; onLeave: () => void }) {
  const st = useSeatState(seat);
  const phase = st?.phase ?? "starting";
  const host = spec.hostName;
  const line =
    phase === "starting"
      ? "Opening your camera…"
      : phase === "waiting"
        ? `Waiting for ${host} to bring you on`
        : phase === "connecting"
          ? st?.message || `Connecting to ${host}'s room…`
          : phase === "live"
            ? st?.hasProgram
              ? `You're in ${host}'s room — you're on whenever ${host} puts you on stage`
              : `You're in ${host}'s room`
            : st?.message || "This seat is closed.";
  const sub =
    phase === "gone" || phase === "error"
      ? null
      : st?.producerCam
        ? "Your Producer stage is your camera — what's on it is what they see."
        : "Your webcam is your camera. Start the virtual camera to send your stage instead.";
  return (
    <section className={`rm-seat rm-seat--${phase}`} aria-live="polite">
      <div className="rm-seat-self">
        <Stream stream={seat?.localStream() ?? null} className="rm-seat-cam" muted />
        {st?.cameraOff && <span className="rm-seat-camoff">Camera off</span>}
      </div>
      <div className="rm-seat-text">
        <div className="rm-seat-eyebrow">
          <span className={`rm-seat-dot rm-seat-dot--${phase}`} />
          {spec.title}
        </div>
        <div className="rm-seat-line">{line}</div>
        {sub && <div className="rm-seat-sub">{sub}</div>}
      </div>
      {st?.hasProgram && (
        <div className="rm-seat-return" title={`${host}'s program`}>
          <Stream stream={seat?.programStream() ?? null} className="rm-seat-program" muted />
          <span className="rm-seat-return-label">PROGRAM</span>
        </div>
      )}
      <HostAudio stream={seat?.hostAudioStream() ?? null} />
      <div className="rm-seat-actions">
        <button className={`hd-chip${st?.muted ? " rm-seat-off" : ""}`} onClick={() => seat?.toggleMute()} disabled={!seat}>
          {st?.muted ? "Unmute" : "Mute"}
        </button>
        <button className={`hd-chip${st?.cameraOff ? " rm-seat-off" : ""}`} onClick={() => seat?.toggleCamera()} disabled={!seat}>
          {st?.cameraOff ? "Start camera" : "Stop camera"}
        </button>
        <button className="hd-chip rm-seat-leave" onClick={onLeave}>
          {phase === "gone" || phase === "error" ? "Back" : "Leave the room"}
        </button>
      </div>
    </section>
  );
}

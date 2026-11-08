/** The green room — a Producer room in GUEST mode.
 *
 * The room view is the guest's own stage (their scene is their camera); this
 * strip above it is the seat: self-view, the host's program return once it
 * arrives, and one line of truth about where they are — waiting for the
 * host, connecting, in the room. They can stay here as long as they like.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { GuestSeat, type GuestSeatSpec, type SeatState } from "../lib/guestSeat";
import { ExpandableProgram } from "../components/ExpandableProgram";
import { useReturnAudio } from "../features/network/useReturnAudio";

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

export function GreenRoomBar({ seat, spec, onLeave }: { seat: GuestSeat | null; spec: GuestSeatSpec; onLeave: () => void }) {
  const st = useSeatState(seat);
  const audio = useReturnAudio({seat, stream: seat?.hostAudioStream() ?? null});
  const audioStatusId = useId();
  const phase = st?.phase ?? "starting";
  const host = spec.hostName;
  const line =
    phase === "starting"
      ? spec.videoSource==='program'?"Preparing your local room…":"Preparing your guest seat…"
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
        : st?.mediaMode==='program'
        ? "Source: your room and Set with processed local audio."
        : "Source: your webcam and microphone.";
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
          {st?.transport && <span> · {st.transport==='livekit'?'LiveKit':'Guest link'}</span>}
        </div>
        <div className="rm-seat-line">{line}</div>
        {sub && <div className="rm-seat-sub">{sub}</div>}
      </div>
      {st?.hasProgram && (
        <ExpandableProgram title={`${host}'s program`}>
          <Stream stream={seat?.programStream() ?? null} className="rm-seat-program" muted />
        </ExpandableProgram>
      )}
      <audio ref={audio.audioRef} autoPlay hidden />
      <div className="rm-seat-actions">
        {(phase==='live'||phase==='connecting')&&<div className="rm-seat-audio">
          <button className={`hd-chip${audio.status==='playing'?' rm-seat-listening':''}`}
            disabled={!seat||audio.status==='playing'}
            onClick={audio.enableAudio} aria-describedby={audioStatusId}>
            {audio.status==='playing'?'Listening':audio.status==='starting'?'Enabling audio…':audio.status==='error'||audio.status==='blocked'?'Retry audio':'Enable audio'}
          </button>
          <span id={audioStatusId} className="rm-seat-audio-status"
            role={audio.status==='error'?'alert':'status'}>{audio.message}</span>
        </div>}
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

/** A webcam-only appearance has no local room graph to render or restore. */
export function ProducerGuestView({spec,onLeave}:{spec:GuestSeatSpec;onLeave:()=>void}){
  const seat=useGuestSeat(spec),state=useSeatState(seat);
  return <main className="producer-guest-view">
    <GreenRoomBar seat={seat} spec={spec} onLeave={onLeave}/>
    <section className="producer-guest-stage" aria-label="Host program return">
      {state?.hasProgram?<Stream stream={seat?.programStream()??null} className="producer-guest-program" muted/>:
      <div><h1>{state?.phase==='waiting'?'You’re in the green room':state?.phase==='error'?'Could not join the show':`Joining ${spec.hostName}`}</h1><p>{state?.message||'The host’s program appears here when it is available.'}</p></div>}
    </section>
  </main>;
}

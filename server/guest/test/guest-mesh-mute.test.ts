import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestMesh } from "../src/guestMesh";

class Track {
  kind = "audio"; enabled = true; readyState = "live";
  clone() { const clone = new Track(); clone.enabled = this.enabled; return clone; }
  stop() { this.readyState = "ended"; }
}
class Stream {
  tracks: Track[] = [];
  getAudioTracks() { return this.tracks; }
  addTrack(t: Track) { this.tracks.push(t); }
}
class Peer {
  static all: Peer[] = [];
  transceiver: any;
  constructor() { Peer.all.push(this); }
  addTransceiver(track: Track | string, options: any) { this.transceiver = { direction: options.direction, sender: { track: typeof track === "string" ? null : track, replaceTrack: async (next: Track) => { this.transceiver.sender.track = next; } } }; return this.transceiver; }
  getSenders() { return [this.transceiver.sender]; }
  close() {}
}
function setup() {
  Peer.all = [];
  vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("MediaStream", Stream);
  const original = new Track();
  const stream = new Stream(); stream.addTrack(original);
  const mesh = new GuestMesh({ selfId: "self", iceServers: [], localStream: () => stream as unknown as MediaStream, send: () => {}, onPeerAudio: () => {} });
  mesh.applyStage({ on_stage: ["self", "other"], version: 1 }, "host");
  return { original, stream, mesh };
}
afterEach(() => vi.unstubAllGlobals());
describe("participant microphone privacy", () => {
  it("mutes every cloned sender and keeps future peers muted", () => {
    const { original, mesh } = setup();
    expect(Peer.all[0].transceiver.sender.track.enabled).toBe(true);
    original.enabled = false; mesh.setMicrophoneEnabled(false);
    mesh.applyStage({ on_stage: ["self", "other", "new"], version: 2 }, "host");
    expect(Peer.all.every(p => !p.transceiver.sender.track.enabled)).toBe(true);
    mesh.close(); expect(original.readyState).toBe("live");
  });
  it("obeys host audio mute independently of video placement", () => {
    const { mesh } = setup();
    mesh.applyStage({ on_stage: ["self", "other"], audible: ["other"], version: 2 }, "host");
    expect(Peer.all[0].transceiver.direction).toBe("recvonly");
    expect(Peer.all[0].transceiver.sender.track.enabled).toBe(false);
  });
  it("requires fresh host confirmation after a disconnect or server cache update", () => {
    const { mesh } = setup();
    mesh.suspend(); expect(Peer.all[0].transceiver.sender.track.enabled).toBe(false);
    mesh.applyStage({ on_stage: ["self", "other"], version: 2 }, "server");
    expect(Peer.all[0].transceiver.sender.track.enabled).toBe(false);
    mesh.applyStage({ on_stage: ["self", "other"], version: 2 }, "host");
    expect(Peer.all[0].transceiver.sender.track.enabled).toBe(true);
  });
  it("replaces an ended microphone without unmuting the replacement or stopping its owner", async () => {
    const { original, stream, mesh } = setup();
    mesh.setMicrophoneEnabled(false);
    const fresh = new Track(); stream.tracks = [fresh];
    mesh.refreshMicrophone(); await Promise.resolve();
    expect(Peer.all[0].transceiver.sender.track.enabled).toBe(false);
    expect(fresh.readyState).toBe("live"); expect(original.readyState).toBe("live");
  });
});

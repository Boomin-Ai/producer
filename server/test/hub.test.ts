// RealtimeHub — grants enforced at the signaling layer (#46).
import { describe, expect, it } from "vitest";
import { RealtimeHub } from "../src/realtime";
import type { Env } from "../src/env";
import { FakeState, asState, upgrade } from "./do";

const env = {} as Env;

async function connect(state: FakeState, hub: RealtimeHub, headers: Record<string, string>) {
  await hub.acceptUpgrade(upgrade(headers));
  const sockets = state.getWebSockets();
  return sockets[sockets.length - 1] as unknown as import("./do").FakeSocket;
}

describe("[grant] the DO enforces media.screen on the screen peer", () => {
  it("drops a guest's screen offer without media.screen and relays it with the grant", async () => {
    const state = new FakeState();
    const hub = new RealtimeHub(asState(state), env);
    const host = await connect(state, hub, { "X-Producer-User": "host:g1", "X-Producer-Room": "r1", "X-Producer-Role": "host" });
    const guest = await connect(state, hub, {
      "X-Producer-User": "guest:g1",
      "X-Producer-Room": "r1",
      "X-Producer-Role": "guest",
      "X-Producer-Grants": JSON.stringify(["media.camera", "media.mic"]),
    });
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { peer: "screen", sdp: "offer" } }));
    expect(host.sent).toHaveLength(0);
    expect(guest.frames()[0]).toMatchObject({ type: "error", code: "grant_required", grant: "media.screen", status: 403 });
    // The camera peer is unaffected.
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { sdp: "offer" } }));
    expect(host.frames()[0]).toMatchObject({ type: "signal", from: "guest:g1", payload: { sdp: "offer" } });

    const sharer = await connect(state, hub, {
      "X-Producer-User": "guest:g2",
      "X-Producer-Room": "r1",
      "X-Producer-Role": "guest",
      "X-Producer-Grants": JSON.stringify(["media.camera", "media.screen"]),
    });
    await hub.webSocketMessage(sharer as never, JSON.stringify({ type: "signal", payload: { peer: "screen", sdp: "offer" } }));
    expect(host.frames().at(-1)).toMatchObject({ from: "guest:g2", payload: { peer: "screen" } });
  });

  it("a socket from before grants (no header) is a guest on the default bundle: no screen", async () => {
    const state = new FakeState();
    const hub = new RealtimeHub(asState(state), env);
    const guest = await connect(state, hub, { "X-Producer-User": "guest:g1", "X-Producer-Room": "r1" });
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { peer: "screen" } }));
    expect(guest.frames()[0]).toMatchObject({ code: "grant_required" });
  });
});

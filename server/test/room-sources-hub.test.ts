import { describe, expect, it } from "vitest";
import { RealtimeHub } from "../src/realtime";
import { FakeState } from "./do";
import type { Env } from "../src/env";

describe("room source action authorization and confirmation", () => {
  it("routes moderator changes only to the current engine and denies guests, stale hosts and expired controls", async () => {
    const state = new FakeState();
    const host = state.attach("host", { userId: "host", role: "host", roomControl: true, publisherId: "engine", channels: [] });
    const mod = state.attach("mod", { userId: "mod", role: "control", roomControl: true, grants: ["room.scene", "room.stage"], channels: [] });
    const guest = state.attach("guest", { userId: "guest", role: "guest", channels: [] });
    const otherHost = state.attach("other", { userId: "other", role: "host", roomControl: true, publisherId: "other", channels: [] });
    const hub = new RealtimeHub(state as unknown as DurableObjectState, {} as Env);
    const send = (ws: typeof host, frame: object) => hub.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(frame));
    await send(host, { type: "scene.publish", command_protocol: 2, scenes: [{ id: "one", name: "One" }], active_scene_id: "one" });
    const camera = { id: "camera", participant_id: "mod-session", owner_id: "mod", label: "Camera", kind: "camera", visible: false, muted: true, ready: true, scene_id: "one" };
    const publication = { sources: [camera], participants: ["mod-session"], on_stage: [] };
    await send(host, { type: "room.sources.publish", ...publication });
    const action = { type: "room.action", command_id: "show", kind: "source.visibility", target: "camera", on: true, expected_revision: 1 };
    await send(guest, action);
    expect(guest.frames().at(-1)).toMatchObject({ type: "error", code: "forbidden" });
    await send(mod, action);
    expect(host.frames().find(f => f.type === "room.action")).toMatchObject({ type: "room.action", command_id: "show", status: "accepted" });
    await send(otherHost, { type: "room.action.ack", command_id: "show", status: "applied", ...publication });
    expect(otherHost.frames().at(-1)).toMatchObject({ code: "stale_publisher" });
    await send(host, { type: "room.action.ack", command_id: "show", status: "applied", ...publication, sources: [{ ...camera, visible: true }] });
    expect(mod.frames().at(-1)).toMatchObject({ type: "room.action.command", command_id: "show", status: "applied" });
    const expired = state.attach("expired", { userId: "mod", role: "control", roomControl: true, authExpiresAt: Date.now() - 1, grants: ["room.scene"], channels: [] });
    await send(expired, { ...action, command_id: "expired" });
    expect(expired.closed).toBe(4001);
  });
});

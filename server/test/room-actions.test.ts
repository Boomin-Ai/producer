import { describe, expect, it } from "vitest";
import { RoomActions, type RoomSource } from "../src/roomActions";
import { FakeState } from "./do";

const camera: RoomSource = { id: "camera", participant_id: "mod-session", owner_id: "member", label: "Camera", kind: "camera", visible: false, muted: true, ready: true, scene_id: "one", revision: 0 };
async function setup() {
  const storage = new FakeState().storage;
  const actions = new RoomActions(storage);
  await actions.publish("host", 1, [camera], ["guest", "mod-session"], []);
  return { actions, storage };
}
const request = { command_id: "show", kind: "source.visibility" as const, target: "camera", on: true, from: "mod", expected_revision: 1 };

describe("host-confirmed room sources", () => {
  it("does not turn an accepted request or unrelated host publication into confirmation", async () => {
    const { actions } = await setup();
    await actions.submit(request, 100);
    expect((await actions.snapshot()).sources[0].visible).toBe(false);
    await actions.publish("host", 1, [{ ...camera, muted: false }], ["guest", "mod-session"], ["guest"]);
    expect((await actions.snapshot()).commands[0].status).toBe("accepted");
    expect((await actions.acknowledge("host", 1, "show", "applied", 200)).status).toBe("failed");
  });
  it("confirms camera and screen independently and persists through eviction", async () => {
    const { actions, storage } = await setup();
    await actions.publish("host", 1, [camera, { ...camera, id: "screen", kind: "screen" }], ["mod-session"], []);
    await actions.submit(request, 100);
    await actions.submit({ ...request, command_id: "screen-show", target: "screen" }, 100);
    await actions.publish("host", 1, [{ ...camera, visible: true }, { ...camera, id: "screen", kind: "screen" }], ["mod-session"], []);
    const resumed = new RoomActions(storage);
    expect((await resumed.acknowledge("host", 1, "show", "applied", 200)).status).toBe("applied");
    expect((await resumed.snapshot()).commands.find(c => c.target === "screen")?.status).toBe("accepted");
  });
  it("rejects stale sources, conflicting retries and forged or old publisher acknowledgments", async () => {
    const { actions } = await setup();
    await expect(actions.submit({ ...request, expected_revision: 0 }, 100)).rejects.toMatchObject({ code: "stale_source" });
    const accepted = await actions.submit(request, 100);
    expect(await actions.submit(request, 200)).toEqual(accepted);
    await expect(actions.submit({ ...request, on: false }, 200)).rejects.toMatchObject({ code: "command_id_conflict" });
    await expect(actions.acknowledge("other", 1, "show", "applied", 200)).rejects.toMatchObject({ code: "stale_publisher" });
    await expect(actions.publish("other", 1, [camera], [], [])).rejects.toMatchObject({ code: "stale_publisher" });
    await actions.publish("new-host", 2, [camera], [], []);
    await expect(actions.acknowledge("host", 1, "show", "applied", 200)).rejects.toMatchObject({ code: "stale_publisher" });
  });
  it("does not confirm a placement in a different scene or reconnected participant", async () => {
    const { actions } = await setup();
    await actions.submit(request, 100);
    await actions.publish("host", 1, [{ ...camera, visible: true, scene_id: "two" }], ["guest", "mod-session"], []);
    expect((await actions.acknowledge("host", 1, "show", "applied", 200)).status).toBe("failed");
    await actions.submit({ ...request, command_id: "next", expected_revision: 2 }, 300);
    await actions.publish("host", 1, [{ ...camera, visible: true, scene_id: "two", participant_id: "new-session" }], ["new-session"], []);
    expect((await actions.acknowledge("host", 1, "next", "applied", 400)).status).toBe("failed");
  });
  it("expires silent commands and fails sources that disappeared", async () => {
    const { actions } = await setup();
    await actions.submit(request, 100);
    expect((await actions.expire(6100))[0].status).toBe("expired");
    await actions.submit({ ...request, command_id: "missing" }, 7000);
    await actions.publish("host", 1, [], [], []);
    expect((await actions.snapshot()).commands.at(-1)).toMatchObject({ status: "failed", error: "source_unavailable" });
  });
  it("uses participant deltas without overwriting another moderator's stage change", async () => {
    const { actions } = await setup();
    await actions.submit({ command_id: "a", kind: "participant.stage", target: "guest", on: true, from: "mod-a" }, 100);
    await actions.submit({ command_id: "b", kind: "participant.stage", target: "mod-session", on: true, from: "mod-b" }, 100);
    await actions.publish("host", 1, [camera], ["guest", "mod-session"], ["guest", "mod-session"]);
    expect((await actions.acknowledge("host", 1, "a", "applied", 200)).status).toBe("applied");
    expect((await actions.acknowledge("host", 1, "b", "applied", 200)).status).toBe("applied");
  });
});

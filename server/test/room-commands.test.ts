import { describe, expect, it } from "vitest";
import { RoomCommands } from "../src/roomCommands";
import { FakeState } from "./do";

async function setup() {
  const storage = new FakeState().storage;
  const commands = new RoomCommands(storage);
  await commands.publish("host-a", [{ id: "one", name: "One" }, { id: "two", name: "Two" }], "one", true);
  return { commands, storage };
}
describe("room command authority", () => {
  it("orders simultaneous moderators and only acknowledges the newest cut", async () => {
    const { commands } = await setup();
    const [a, b] = await Promise.all([
      commands.submit({ command_id: "a", scene_id: "two", from: "mod-a" }, 100),
      commands.submit({ command_id: "b", scene_id: "one", from: "mod-b" }, 100),
    ]);
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    expect((await commands.acknowledge("host-a", "a", "applied", 200)).status).toBe("superseded");
    expect((await commands.acknowledge("host-a", "b", "applied", 200)).status).toBe("applied");
    expect((await commands.snapshot()).active_scene_id).toBe("one");
  });
  it("resumes durable state without replaying a cut, and deduplicates retries", async () => {
    const { commands, storage } = await setup();
    const input = { command_id: "same", scene_id: "two", from: "mod" };
    const original = await commands.submit(input, 100);
    const resumed = new RoomCommands(storage);
    expect(await resumed.submit(input, 200)).toEqual(original);
    expect((await resumed.snapshot()).active_scene_id).toBe("one");
    await expect(resumed.submit({ ...input, scene_id: "one" }, 200)).rejects.toMatchObject({ code: "command_id_conflict" });
  });
  it("never lights an expired or failed cut as on air", async () => {
    const { commands } = await setup();
    await commands.submit({ command_id: "late", scene_id: "two", from: "mod" }, 100);
    expect((await commands.acknowledge("host-a", "late", "applied", 4100)).status).toBe("expired");
    await commands.submit({ command_id: "bad", scene_id: "two", from: "mod" }, 5000);
    expect((await commands.acknowledge("host-a", "bad", "failed", 5100)).status).toBe("failed");
    expect((await commands.snapshot()).active_scene_id).toBe("one");
  });
  it("rejects another live publisher and stale acknowledgments after takeover", async () => {
    const { commands } = await setup();
    await expect(commands.publish("host-b", [{ id: "one", name: "One" }], "one", false)).rejects.toMatchObject({ code: "publisher_busy" });
    await commands.submit({ command_id: "a", scene_id: "two", from: "mod" }, 100);
    await commands.publish("host-b", [{ id: "one", name: "One" }], "one", true);
    await expect(commands.acknowledge("host-a", "a", "applied", 200)).rejects.toMatchObject({ code: "stale_publisher" });
  });
});

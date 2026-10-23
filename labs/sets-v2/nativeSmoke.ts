import { invoke } from "@tauri-apps/api/core";
import { compileSet } from "../../src/features/sets-v2/scene";
import { pollSet } from "../../src/features/sets-v2/fixtures";
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function nativeRoomSmoke(): Promise<string> {
  let generation = 0,
    revision = 0;
  const events: unknown[] = [];
  const call = async (request: Record<string, unknown>) =>
    invoke<{
      preparedRevision: number;
      renderedRevision: number;
      renderSerial: number;
      ready: boolean;
      warmed: boolean;
      transitioning: boolean;
      generation: number;
    }>("live_set_v2", { request: { generation, ...request } });
  try {
    let booted = false;
    for (let i = 0; i < 500; i++) {
      const engine = await invoke<{ engine_ready: boolean }>(
        "live_engine_status",
      );
      if (engine.engine_ready) {
        booted = true;
        break;
      }
      await pause(40);
    }
    if (!booted) throw Error("Native engine did not start");
    await invoke("live_set_video", { height: 720, fps: 30 });
    await invoke("live_add_source", {
      id: "sets-v2-demo-source",
      label: "V2 synthetic host",
      spec: { kind: "color", color: "#20c060" },
    });
    generation = (await invoke<{ generation: number }>("live_set_status"))
      .generation;
    for (const mode of [
      "dissolve",
      "wipe",
      "slide",
      "dissolve",
      "wipe",
      "slide",
    ]) {
      const style = revision % 2 ? "spotlight" : "bars";
      const definition = pollSet(style);
      const plan = compileSet(
        definition,
        {
          id: "native-room",
          definitionId: definition.id,
          bindings: { host: "sets-v2-demo-source" },
        },
        {
          id: "program",
          orientation: "landscape",
          width: 1280,
          height: 720,
          scaling: "contain",
        },
        {},
      );
      const prior = revision;
      await call({ op: "prepare", revision: ++revision, plan });
      let ready = false;
      for (let i = 0; i < 400; i++) {
        const status = await call({ op: "status" });
        if (status.renderedRevision !== prior)
          throw Error("Preparing changed the confirmed output revision");
        if (status.ready && status.warmed) {
          ready = true;
          break;
        }
        await pause(25);
      }
      if (!ready) throw Error("First paint/texture preparation timed out");
      await call({ op: "take", revision, durationMs: 350, mode });
      let confirmed = false;
      for (let i = 0; i < 200; i++) {
        const status = await call({ op: "status" });
        if (status.renderedRevision === revision && !status.transitioning) {
          events.push({ style, mode, ...status });
          confirmed = true;
          break;
        }
        await pause(20);
      }
      if (!confirmed) throw Error("Rendered receipt timed out");
    }
    const returned = await call({ op: "return" });
    let staleRejected = false;
    try {
      await call({ op: "take", revision, durationMs: 0, mode: "dissolve" });
    } catch {
      staleRejected = true;
    }
    if (!staleRejected || returned.generation === generation)
      throw Error("Returned room did not invalidate old requests");
    await invoke("live_set_v2_report", {
      result: {
        ok: true,
        events,
        source: "synthetic color, no capture devices",
        staleAfterReturnRejected: true,
        completedAt: new Date().toISOString(),
      },
    });
    return "Native app smoke passed: six set switches through Tauri, engine thread and render receipts. Returned to room.";
  } catch (error) {
    await invoke("live_set_v2_report", {
      result: {
        ok: false,
        error: String(error),
        events,
        completedAt: new Date().toISOString(),
      },
    }).catch(() => {});
    throw error;
  }
}

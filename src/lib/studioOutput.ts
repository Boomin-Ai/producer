/** Studio output ("Broadcast the studio", v0.4.37) — the pure half.
 *
 * Three consumers read the engine, and the whole trick against the infinite
 * mirror is that only ONE of them sees the studio scene (a capture of
 * Producer's own window): the PROGRAM (stream/record). The STAGE inside the
 * window draws the room scene, and the RETURN FEED (virtual camera → guests'
 * return, mod monitors) is fed the room scene too. Mirrors
 * src-tauri/src/live/studio.rs `output_scene_for`. */
export type StudioConsumer = "program" | "stage" | "return";
export type StudioScene = "room" | "studio";

export function outputSceneFor(consumer: StudioConsumer, studioOn: boolean): StudioScene {
  return studioOn && consumer === "program" ? "studio" : "room";
}

/** Room-doc field → engine request, with the reasons a click can't take. */
export function studioToggleTarget(current: boolean | undefined, engineOk: boolean): { on: boolean } | { blocked: string } {
  if (!engineOk) return { blocked: "The engine isn't running yet." };
  return { on: !current };
}

/** Studio output ("Broadcast the studio", v0.4.37) — the pure half.
 *
 * Three consumers read the engine. The trick against the infinite mirror is
 * that the STAGE — the preview inside the very window the studio scene
 * captures — always draws the room. The PROGRAM (stream/record) and the
 * RETURN FEED (virtual camera → Meet/Zoom, guests' return, mod monitors)
 * both show the studio while it is on. Mirrors
 * src-tauri/src/live/studio.rs `output_scene_for`. */
export type StudioConsumer = "program" | "stage" | "return";
export type StudioScene = "room" | "studio";

export function outputSceneFor(consumer: StudioConsumer, studioOn: boolean): StudioScene {
  // v0.4.48: the RETURN feed follows the program into the studio. "Broadcast
  // the studio" has to mean every output, or a host using Producer as their
  // camera in Meet or Zoom sends the bare stage while the stream sends the
  // studio — the same switch, two different pictures.
  //
  // The STAGE is the one that must stay on the room: it is the in-app preview,
  // and the studio scene is a capture of that very window. Point it at the
  // studio and you have the infinite mirror this design exists to avoid.
  return studioOn && consumer !== "stage" ? "studio" : "room";
}

/** Room-doc field → engine request, with the reasons a click can't take. */
export function studioToggleTarget(current: boolean | undefined, engineOk: boolean): { on: boolean } | { blocked: string } {
  if (!engineOk) return { blocked: "The engine isn't running yet." };
  return { on: !current };
}

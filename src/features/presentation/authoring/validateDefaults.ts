import {RehearsalSession} from '../rehearsal';
import {outputProjection} from '../projection';
import type {PresentationPackage} from '../schema';

/** Pure default-state projection, off the room/render hot path. This checks
 * every layout but does not claim GPU, device or every control-state readiness. */
export function validateAuthoredDefaults(document: PresentationPackage) {
  const session = new RehearsalSession(document, undefined, 'prepare');
  try {
    const state = session.snapshot();
    for (const layout of document.set.layouts) {
      try {outputProjection(document, {...state, layoutId: layout.id});}
      catch (error) {
        const message = (error instanceof Error ? error.message : String(error))
          .replace(/(?:data:|(?:file|https?):\/\/)[^\s"'<>]+/gi, '[resource]').slice(0, 1600);
        throw Error(`Layout ${layout.id} default preview: ${message}`);
      }
    }
  } finally {session.moduleRuntime.shutdown();}
  return {validation: 'canonical-schema-references-and-default-projection' as const, layouts: document.set.layouts.length, nativeReadiness: 'not-tested' as const};
}

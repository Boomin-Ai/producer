import grandArena from '../../../docs/shows/head-to-head-grand-arena.json';
import decisionRoom from '../../../docs/shows/decision-room.json';
import openFloor from '../../../docs/shows/open-floor.json';
import atmosphere from '../../../docs/shows/atmosphere.json';
import studio3d from '../../../docs/shows/grand-arena-3d-study.json';
import justFacts from '../../../docs/shows/just-facts.json';
import { parsePackage } from './schema';

/** Fresh authoring catalog. Older fixtures are regression inputs, not templates. */
export const GRAND_ARENA = parsePackage(grandArena);
export const BUILTIN_SETS = [GRAND_ARENA,...[decisionRoom,openFloor,atmosphere,justFacts,studio3d].map(parsePackage)];

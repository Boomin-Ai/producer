import grandArena from '../../../docs/shows/head-to-head-grand-arena.json';
import { parsePackage } from './schema';

/** Fresh authoring catalog. Older fixtures are regression inputs, not templates. */
export const GRAND_ARENA = parsePackage(grandArena);
export const BUILTIN_SETS = [GRAND_ARENA];

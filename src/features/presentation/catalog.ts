import threadsDashboard from '../../../docs/shows/threads-live-dashboard.json';
import atmosphere from '../../../docs/shows/atmosphere.json';
import { parsePackage } from './schema';

/** Built-in templates match across desktop build modes. */
export const DEFAULT_SET = parsePackage(atmosphere);
export const BUILTIN_SETS = [DEFAULT_SET, parsePackage(threadsDashboard)];

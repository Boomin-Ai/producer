import signalDesk from './fixtures/signal-desk.json';
import afterHours from './fixtures/after-hours.json';
import headToHead from './fixtures/head-to-head.json';
import { parsePackage } from './schema';

export const AFTER_HOURS = parsePackage(afterHours);
export const HEAD_TO_HEAD = parsePackage(headToHead);
export const SIGNAL_DESK = parsePackage(signalDesk);

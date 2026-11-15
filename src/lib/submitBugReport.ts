import {guests} from './ipc';
import {isBoomin, resolveActiveEndpoint} from './workspace';
import type {BugReport} from './bugReport';

const SUPPORT_PATH = '/v1/app/support/report';

export function resolveBugReporter() {
  return resolveActiveEndpoint()
    .then(endpoint => endpoint && isBoomin(endpoint) ? endpoint.id : null)
    .catch(() => null);
}

export async function submitBugReport(report: BugReport, endpointId: string | null) {
  if (endpointId) {
    const response = await guests.request(endpointId, 'POST', SUPPORT_PATH, report);
    if (!response.available) throw Error('This server has no bug-report route.');
    return (response.body ?? {}) as Record<string, unknown>;
  }
  const response = await fetch('https://api.boomin.ai' + SUPPORT_PATH, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(report),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw Error(response.status === 429
      ? 'Too many reports in the last hour. Try again shortly.'
      : typeof body.message === 'string' ? body.message : `The server answered ${response.status}.`);
  }
  return body;
}

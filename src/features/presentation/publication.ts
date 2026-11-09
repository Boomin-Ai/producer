import { validatePackageText } from './validation';
import type { PresentationPackage } from './schema';

/** Public hosting has a smaller admission budget than local, 40 MiB imports. */
export const PUBLIC_PACKAGE_BYTES = 8 * 1024 * 1024;
export const PUBLIC_THUMBNAIL_BYTES = 512 * 1024;
export type PublicOrientation = 'landscape' | 'portrait' | 'square';
export interface PublicationIssue { code: string; path: string; message: string }
export type PublicPackageValidation =
  | { ok: true; package: PresentationPackage; text: string; summary: {
    id: string; name: string; layout_count: number; orientations: PublicOrientation[];
  } }
  | { ok: false; errors: PublicationIssue[] };

/** Portable package admission shared by the app, CLI and hosted API.
 * Does not capture sources, resolve local media, connect accounts or execute a Set.
 * All authored values/assets are part of the download; this is not a secret scrubber.
 */
export function validatePublicPackageText(text: string): PublicPackageValidation {
  const reject = (code: string, path: string, message: string): PublicPackageValidation =>
    ({ ok: false, errors: [{ code, path, message }] });
  if (text.length > PUBLIC_PACKAGE_BYTES || new TextEncoder().encode(text).byteLength > PUBLIC_PACKAGE_BYTES)
    return reject('package_too_large', '$', 'Public Set packages must be at most 8 MiB. Local imports support larger packages.');
  const result = validatePackageText(text);
  if (!result.ok) return { ok: false, errors: result.issues.map(issue => ({
    code: issue.code, path: issue.path.slice(0, 200), message: issue.message.slice(0, 320),
  })) };
  let problem: PublicationIssue | undefined;
  function visit(value: unknown, path: string): void {
    if (problem) return;
    if (typeof value === 'string') {
      // Only embedded assets are portable. Never turn a private media UUID or
      // a tokenized local resolver address into a public download.
      if (/producer-media:|\bfile:\/\/|\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[/:?#]|$)/i.test(value))
        problem = { code: 'local_reference', path, message: 'Replace device-local media and addresses with embedded, shareable assets before publishing.' };
      else if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|[?&](?:access_token|refresh_token|auth_token|api_key|client_secret|signature|x-amz-signature)=/i.test(value))
        problem = { code: 'credential_reference', path, message: 'Remove private credentials and signed account links before publishing.' };
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`.slice(0, 200));
  }
  visit(result.package, '$');
  if (problem) return { ok: false, errors: [problem] };
  const canonical = JSON.stringify(result.package);
  if (new TextEncoder().encode(canonical).byteLength > PUBLIC_PACKAGE_BYTES)
    return reject('package_too_large', '$', 'The normalized public Set package exceeds 8 MiB.');
  const orientations = [...new Set(result.package.set.layouts.map(layout =>
    layout.width > layout.height ? 'landscape' : layout.width < layout.height ? 'portrait' : 'square'))] as PublicOrientation[];
  return { ok: true, package: result.package, text: canonical, summary: {
    id: result.package.id, name: result.package.name, layout_count: result.package.set.layouts.length, orientations,
  } };
}

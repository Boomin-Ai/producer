import { PACKAGE_BYTES } from './assets';
import { PackageError, parsePackage, type PresentationPackage } from './schema';

export type PackageIssueCode = 'package_too_large' | 'nesting_limit' | 'invalid_json' | 'invalid_package';
export interface PackageIssue { code: PackageIssueCode; path: string; message: string }
export type PackageValidation =
  | { ok: true; package: PresentationPackage }
  | { ok: false; issues: PackageIssue[] };

export class PackageValidationError extends Error {
  constructor(public issues: PackageIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'PackageValidationError';
  }
}

/** Shared text admission; no execution, installation or output mutation.
 * Schema validation is not native readiness or peak GPU resource admission. */
export function validatePackageText(text: string): PackageValidation {
  const reject = (code: PackageIssueCode, message: string, path = '$'): PackageValidation =>
    ({ ok: false, issues: [{ code, path, message }] });
  if (text.length > PACKAGE_BYTES || new TextEncoder().encode(text).byteLength > PACKAGE_BYTES)
    return reject('package_too_large', 'Set package exceeds 40 MB.');
  // Preflight nesting before JSON.parse; the codec has tighter semantic limits.
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      if (++depth > 64) return reject('nesting_limit', 'JSON nesting exceeds 64 levels.');
    } else if (c === '}' || c === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return reject('invalid_json', 'Expected a complete JSON package.'); }
  try { return { ok: true, package: parsePackage(value) }; }
  catch (error) {
    if (error instanceof PackageError)
      return reject('invalid_package', error.message.slice(error.path.length + 2), error.path);
    // Validator defects must not be disguised as model/user mistakes.
    throw error;
  }
}

export function parsePackageText(text: string): PresentationPackage {
  const result = validatePackageText(text);
  if (!result.ok) throw new PackageValidationError(result.issues);
  return result.package;
}

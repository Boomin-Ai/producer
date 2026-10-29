import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validationRuntime } from './validate-set.mjs';
const { validatePackageText, parsePackageText, PackageValidationError } = await validationRuntime();
const reference = JSON.parse(readFileSync('docs/shows/attention-is-currency.json', 'utf8'));
for (const file of ['docs/shows/attention-is-currency.json', 'docs/shows/atmosphere.json', 'docs/shows/just-facts.json']) {
  const result = validatePackageText(readFileSync(file, 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.package.set.layouts.length >= 2);
}
function rejected(text, code) {
  const result = validatePackageText(text);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, code);
  assert.ok(result.issues[0].path.startsWith('$'));
  assert.throws(() => parsePackageText(text), PackageValidationError);
}
rejected('{"name":', 'invalid_json');
rejected('```json\n{}\n```', 'invalid_json');
rejected('['.repeat(65) + '0' + ']'.repeat(65), 'nesting_limit');
rejected(' '.repeat(40 * 1024 * 1024 + 1), 'package_too_large');
rejected('é'.repeat(21 * 1024 * 1024), 'package_too_large');
const wrongVersion = { ...reference, schema: 'producer.presentation/999' };
rejected(JSON.stringify(wrongVersion), 'invalid_package');
const privateBinding = structuredClone(reference);
privateBinding.set.layouts[0].root.children.push({ id: 'invalid-binding', type: 'text', text: { get: 'modules.missing.secret' } });
rejected(JSON.stringify(privateBinding), 'invalid_package');
const escaped = structuredClone(reference);
escaped.name = '[{"\\'.repeat(15);
assert.equal(validatePackageText(JSON.stringify(escaped)).ok, true, 'string delimiters must not count toward nesting');
assert.deepEqual(parsePackageText(JSON.stringify(reference)), reference, 'admission must preserve authored package');
console.log('PASS: real packages, shared throwing/reporting paths, byte/depth budgets, escaping, schema and binding rejection');

// Verify the public CLI reports failures truthfully and does not echo package bodies.
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { spawnSync } = await import('node:child_process');
const folder = mkdtempSync(join(tmpdir(), 'producer-validation-'));
try {
  const invalid = join(folder, 'invalid.json');
  writeFileSync(invalid, '{"private-input-marker":');
  const rejectedRun = spawnSync(process.execPath, ['scripts/validate-set.mjs', invalid], { encoding: 'utf8' });
  assert.equal(rejectedRun.status, 1);
  assert.equal(JSON.parse(rejectedRun.stdout).issues[0].code, 'invalid_json');
  assert.ok(!rejectedRun.stdout.includes('private-input-marker'));
  const mixed = spawnSync(process.execPath, ['scripts/validate-set.mjs', join(folder, 'missing.json'), invalid], { encoding: 'utf8' });
  assert.equal(mixed.status, 2, 'later rejection must not hide an I/O failure');
  assert.equal(mixed.stdout.trim().split('\n').length, 2);
} finally { rmSync(folder, { recursive: true, force: true }); }
console.log('PASS: CLI exit codes, multi-file reports and malformed-input redaction');

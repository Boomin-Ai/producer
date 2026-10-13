import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/lib/nativeGuestSources.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports });
const { nativeGuestSources } = exports;
const guest = { id: '12345678-1234-1234-1234-123456789abc', display_name: 'Guest' };

test('saved scene key survives while native binding retains full participant identity', () => {
  const sources = nativeGuestSources([guest]);
  assert.equal(sources.size, 1);
  assert.equal(sources.get('guest-12345678').guest, guest);
  assert.equal(sources.get('guest-12345678').track, 'camera');
});
test('two full identities cannot share one saved scene key', () => {
  assert.throws(() => nativeGuestSources([guest, { id: '12345678-ffff-ffff-ffff-ffffffffffff' }]), /collide/);
  assert.throws(() => nativeGuestSources([guest, guest]), /collide/);
});
test('noncanonical or malformed identities never reach the native graph', () => {
  for (const id of ['../guest', guest.id.toUpperCase(), guest.id.replaceAll('-', ''), '']) {
    assert.throws(() => nativeGuestSources([{ id }]), /invalid/);
  }
  assert.equal(nativeGuestSources([]).size, 0);
});

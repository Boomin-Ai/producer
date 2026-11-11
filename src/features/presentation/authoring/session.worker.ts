import {AuthoringSession, type AuthoringJournal} from '../../../../shared/authoring/session';
import {setDocumentAdapter, inspectAuthoredSet, validateAuthoredDefaults, type SetAuthoringCommand} from './service';
import type {AuthoringTarget} from './catalog';
import {parsePackage, presentationJsonSchema, type PresentationPackage} from '../schema';
type Journal = AuthoringJournal<PresentationPackage, SetAuthoringCommand>;
const host = globalThis as unknown as {onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void};
let session: AuthoringSession<PresentationPackage, SetAuthoringCommand> | undefined;
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('producer-authoring', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('Draft storage is unavailable.'));
  });
}
async function load(key: string): Promise<Journal | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('drafts', 'readonly').objectStore('drafts').get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Could not restore the saved draft.'));
  });
}
async function save(key: string, value: Journal) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put(value, key);
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(Error('Could not save this draft. Free storage and retry.'));
  });
}
host.onmessage = async ({data}: MessageEvent<{id: number; method: string; value: any}>) => {
  const {id, method, value} = data;
  try {
    let result: unknown;
    if (method === 'open') {
      const base = parsePackage(value.document), target = value.target as AuthoringTarget;
      if (typeof value.scope !== 'string' || !value.scope || value.scope.length > 512) throw Error('Invalid authoring scope.');
      const adapter = setDocumentAdapter(target), legacyKey = `${value.scope}:${base.id}`;
      const key = `${legacyKey}:${await adapter.revision(base)}`;
      const stored = await load(key) ?? await load(legacyKey);
      const writer = (journal: Journal) => save(key, journal);
      let restored = false;
      if (stored && await adapter.revision(stored.base) === await adapter.revision(base)) {session = await AuthoringSession.restore(adapter, base, stored, writer); restored = true;}
      else session = await AuthoringSession.create(adapter, base, writer);
      result = {...session.snapshot(), restored};
    } else {
      if (!session) throw Error('Open an authoring session first.');
      if (method === 'snapshot') result = session.snapshot();
      else if (method === 'validate') {
        const snapshot = session.snapshot();
        if (snapshot.revision !== value.revision) throw Error('The draft changed before validation.');
        result = {revision: snapshot.revision, ...validateAuthoredDefaults(snapshot.document)};
      }
      else if (method === 'edit') result = await session.edit(value);
      else if (method === 'history') result = await session.moveHistory(value.direction, value.revision);
      else if (method === 'inspect') {
        const snapshot = session.snapshot(); result = {revision: snapshot.revision, ...inspectAuthoredSet(snapshot.document)};
        if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw Error('This Set exceeds the context budget. Select a smaller composition.');
      } else if (method === 'schema') {
        const schema = presentationJsonSchema as any;
        const sections: Record<string, unknown> = {package: schema, node: {node: schema.$defs.node, defs: schema.$defs}, animation: {animation: schema.properties.set.properties.layouts.items.properties.animation, defs: schema.$defs}, controls: {controls: schema.properties.set.properties.controls, arrangement: schema.properties.set.properties.controlArrangement, defs: schema.$defs}, runtime: {runtime: schema.properties.runtime, defs: schema.$defs}, scene3d: schema.$defs};
        if (!Object.prototype.hasOwnProperty.call(sections, value.section)) throw Error('Unknown schema section.');
        result = sections[value.section];
      } else throw Error('Unknown authoring operation.');
    }
    host.postMessage({id, result});
  } catch (error) {host.postMessage({id, error: error instanceof Error ? error.message : String(error)});}
};

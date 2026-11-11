/** Document editing is independent of inference, UI, room and output ownership.
 * Domain adapters retain their canonical validators and resource contracts. */
export interface DocumentAdapter<Document, Command> {
  kind: string;
  revision(document: Document): Promise<string>;
  apply(document: Document, command: Command): Promise<Document>;
  /** Admission for new candidates; replay still verifies the original contract
   * and hashes so older drafts remain recoverable after validation improves. */
  validateForCommit?(document: Document): void | Promise<void>;
}
export interface EditReceipt<Command> {
  operationId: string;
  baseRevision: string;
  revision: string;
  label: string;
  command: Command;
}
export interface AuthoringJournal<Document, Command> {
  schema: 'producer.authoring-journal/1';
  kind: string;
  base: Document;
  entries: EditReceipt<Command>[];
  cursor: number;
}
export type JournalWriter<D, C> = (journal: AuthoringJournal<D, C>) => Promise<void>;

/** One serialized writer per draft. History stores the base once and commands,
 * rather than a complete embedded-media package for every checkpoint. */
export class AuthoringSession<D, C> {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(
    readonly adapter: DocumentAdapter<D, C>,
    private journal: AuthoringJournal<D, C>,
    private current: D,
    private currentRevision: string,
    private persist?: JournalWriter<D, C>,
  ) {}
  static async create<D, C>(adapter: DocumentAdapter<D, C>, base: D, persist?: JournalWriter<D, C>) {
    const document = structuredClone(base);
    return new AuthoringSession(adapter, {schema: 'producer.authoring-journal/1', kind: adapter.kind, base: document, entries: [], cursor: 0}, document, await adapter.revision(document), persist);
  }
  static async restore<D, C>(adapter: DocumentAdapter<D, C>, base: D, input: AuthoringJournal<D, C>, persist?: JournalWriter<D, C>) {
    if (input.schema !== 'producer.authoring-journal/1' || input.kind !== adapter.kind || !Array.isArray(input.entries) || input.entries.length > 24 || !Number.isInteger(input.cursor) || input.cursor < 0 || input.cursor > input.entries.length) throw Error('Invalid saved draft history.');
    if (await adapter.revision(base) !== await adapter.revision(input.base)) throw Error('The source design changed. Start a new draft or reopen its original version.');
    const session = await AuthoringSession.create(adapter, base, persist);
    session.journal = structuredClone(input);
    // Validate ALL stored checkpoints, including redo, before accepting history.
    let document = session.journal.base, revision = await adapter.revision(document);
    for (const entry of session.journal.entries) {
      if (!entry.operationId || entry.baseRevision !== revision) throw Error('Saved draft has inconsistent revisions.');
      document = await adapter.apply(document, entry.command);
      revision = await adapter.revision(document);
      if (revision !== entry.revision) throw Error('Saved draft does not match this authoring contract.');
    }
    await session.restoreCursor(input.cursor);
    return session;
  }
  snapshot() {
    return {document: structuredClone(this.current), revision: this.currentRevision, canUndo: this.journal.cursor > 0, canRedo: this.journal.cursor < this.journal.entries.length, checkpoints: this.journal.entries.slice(0, this.journal.cursor).map(({operationId, revision, label}) => ({operationId, revision, label}))};
  }
  exportJournal() { return structuredClone(this.journal); }
  close() { this.closed = true; }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(() => { if (this.closed) throw Error('This authoring session is closed.'); return run(); });
    this.tail = work.catch(() => undefined);
    return work;
  }
  async edit(input: {operationId: string; baseRevision: string; command: C; label: string}) {
    return this.serialize(async () => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId) || !input.label.trim() || input.label.length > 160) throw Error('Invalid edit identity or label.');
      const prior = this.journal.entries.find(e => e.operationId === input.operationId);
      if (prior) {
        if (this.journal.entries.indexOf(prior) >= this.journal.cursor) throw Error('This operation was undone. Use a new operation ID to apply another edit.');
        if (prior.baseRevision !== input.baseRevision || JSON.stringify(prior.command) !== JSON.stringify(input.command)) throw Error('Operation ID was reused for a different edit.');
        return {receipt: {...prior, replayed: true}, ...this.snapshot()};
      }
      if (input.baseRevision !== this.currentRevision) throw Error('The draft changed. Inspect its current revision before editing.');
      if (this.journal.cursor >= 24) throw Error('This draft has 24 checkpoints. Load the reviewed design before starting another draft.');
      const command = structuredClone(input.command);
      const next = await this.adapter.apply(structuredClone(this.current), command);
      await this.adapter.validateForCommit?.(next);
      const revision = await this.adapter.revision(next);
      if (this.closed) throw Error('This authoring session is closed.');
      const receipt = {operationId: input.operationId, baseRevision: this.currentRevision, revision, label: input.label, command};
      const journal = {...this.journal, entries: [...this.journal.entries.slice(0, this.journal.cursor), receipt], cursor: this.journal.cursor + 1};
      // Persist first: a storage failure leaves the current draft/history intact.
      await this.persist?.(structuredClone(journal));
      if (this.closed) throw Error('This authoring session is closed.');
      this.journal = journal; this.current = next; this.currentRevision = revision;
      return {receipt: {...receipt, replayed: false}, ...this.snapshot()};
    });
  }
  validateCurrent(expectedRevision: string) {
    return this.serialize(async () => {
      if (expectedRevision !== this.currentRevision) throw Error('The draft changed before validation.');
      await this.adapter.validateForCommit?.(structuredClone(this.current));
      if (this.closed) throw Error('This authoring session is closed.');
      return {revision: this.currentRevision};
    });
  }
  private async restoreCursor(cursor: number) {
    let current = structuredClone(this.journal.base);
    for (const entry of this.journal.entries.slice(0, cursor)) current = await this.adapter.apply(current, entry.command);
    const revision = await this.adapter.revision(current);
    const journal = {...this.journal, cursor};
    if (this.closed) throw Error('This authoring session is closed.');
    await this.persist?.(structuredClone(journal));
    if (this.closed) throw Error('This authoring session is closed.');
    this.journal = journal; this.current = current; this.currentRevision = revision;
  }
  moveHistory(direction: 'undo' | 'redo', expectedRevision: string) {
    return this.serialize(async () => {
      if (expectedRevision !== this.currentRevision) throw Error('The draft changed before the history action.');
      const cursor = this.journal.cursor + (direction === 'undo' ? -1 : 1);
      if (cursor < 0 || cursor > this.journal.entries.length) throw Error('No checkpoint in that direction.');
      await this.restoreCursor(cursor);
      return this.snapshot();
    });
  }
}

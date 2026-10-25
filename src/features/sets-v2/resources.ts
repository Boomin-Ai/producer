/** A shared off-air resource registry. A lease is ownership, never stage visibility.
 * Native source creation/device permissions are supplied by an adapter. */
export interface Resource {
  id: string;
  dispose: () => void;
}
export interface ResourceLease<T extends Resource> {
  value: T;
  release: () => void;
}
interface Entry<T> {
  refs: number;
  promise: Promise<T>;
}
export class ResourceRegistry<T extends Resource> {
  private entries = new Map<string, Entry<T>>();
  constructor(
    private create: (key: string) => Promise<T>,
    private limit = 64,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw Error("Invalid resource limit");
  }
  async acquire(key: string): Promise<ResourceLease<T>> {
    if (!key || key.length > 160) throw Error("Invalid resource key");
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.limit)
        throw Error("Resource budget reached");
      const entry: Entry<T> = {
        refs: 0,
        promise: Promise.resolve().then(() => this.create(key)),
      };
      this.entries.set(key, entry);
      e = entry;
    }
    e.refs++;
    const entry = e;
    let value: T;
    try {
      value = await entry.promise;
    } catch (error) {
      entry.refs--;
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs === 0) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          value.dispose();
        }
      },
    };
  }
  get size(): number {
    return this.entries.size;
  }
}

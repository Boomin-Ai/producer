// The server's typecheck deliberately carries no @types/node (it targets
// workerd). The test-only D1 stand-in needs four Node builtins; declare just
// what it uses. Delete this file if @types/node is ever added.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number | bigint };
    };
  }
}
// ESM `import.meta.url` — typed by lib.dom / @types/node, neither of which
// the worker build carries.
interface ImportMeta {
  url: string;
}

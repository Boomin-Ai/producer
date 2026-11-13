import type {PresentationPackage} from '../schema';
import type {AuthoringTarget} from './catalog';
import type {SetAuthoringCommand} from './service';
export interface DraftSnapshot {document: PresentationPackage; revision: string; canUndo: boolean; canRedo: boolean; restored?: boolean; branch?:string; recoverable?:Array<{branch:string;name:string}>; checkpoints: Array<{operationId: string; revision: string; label: string}>}
export class SetAuthoringWorker {
  private worker = new Worker(new URL('./session.worker.ts', import.meta.url), {type: 'module'});
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  constructor() {
    this.worker.onmessage = ({data}) => {const pending = this.pending.get(data.id); if (!pending) return; this.pending.delete(data.id); if (data.error) pending.reject(Error(data.error)); else pending.resolve(data.result);};
    this.worker.onerror = () => this.close('The authoring worker stopped. Reopen the Assistant to restore your saved draft.');
  }
  call<T>(method: string, value: unknown): Promise<T> {
    if (this.closed) return Promise.reject(Error('This authoring session is closed.'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {this.pending.set(id, {resolve, reject}); this.worker.postMessage({id, method, value});});
  }
  open(document: PresentationPackage, target: AuthoringTarget, scope: string, options?:{followRoom?:boolean;branch?:string}) {return this.call<DraftSnapshot>('open', {document, target, scope,...options});}
  edit(baseRevision: string, command: SetAuthoringCommand, label: string, operationId: string = crypto.randomUUID()) {return this.call<DraftSnapshot>('edit', {baseRevision, command, label, operationId});}
  history(direction: 'undo' | 'redo', revision: string) {return this.call<DraftSnapshot>('history', {direction, revision});}
  close(message = 'Authoring session closed.') {if (this.closed) return; this.closed = true; this.worker.terminate(); for (const {reject} of this.pending.values()) reject(Error(message)); this.pending.clear();}
}

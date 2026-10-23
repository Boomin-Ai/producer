import {
  compileSet,
  type OutputTarget,
  type RenderPlan,
  type SetDefinition,
  type SetInstance,
} from "./scene";
import type { PublicData } from "./data";
export interface Candidate {
  id: string;
  plans: RenderPlan[];
  dispose: () => void;
}
export interface PresentedReceipt {
  candidateId: string;
  outputs: string[];
  frame: number;
}
/** Adapter must execute guard.swap synchronously at its actual native output swap,
 * and resolve commit only after those output frames have presented. A JS mock is not native proof. */
export interface Presenter {
  prepare(plans: RenderPlan[], signal: AbortSignal): Promise<Candidate>;
  commit(
    candidate: Candidate,
    guard: { signal: AbortSignal; swap: (action: () => void) => boolean },
  ): Promise<PresentedReceipt>;
}
export interface Program {
  candidate: Candidate;
  receipt: PresentedReceipt;
  instanceId: string;
}
export type SelectionStatus =
  | { state: "idle" }
  | { state: "preparing" | "taking"; instanceId: string }
  | { state: "presented"; instanceId: string }
  | { state: "error"; instanceId: string; message: string };
/** Current program is retained until a fresh candidate is actually presented.
 * This controller does not start a stream, a poll or a rundown by selection. */
export class PresentationController {
  private intent = 0;
  private pending?: AbortController;
  private program?: Program;
  private disposed = false;
  private state: SelectionStatus = { state: "idle" };
  private takeTail: Promise<void> = Promise.resolve();
  private unconfirmed: Candidate[] = [];
  constructor(private presenter: Presenter) {}
  status(): SelectionStatus {
    return { ...this.state };
  }
  current():
    | { instanceId: string; receipt: PresentedReceipt; plans: RenderPlan[] }
    | undefined {
    return this.program
      ? {
          instanceId: this.program.instanceId,
          receipt: structuredClone(this.program.receipt),
          plans: structuredClone(this.program.candidate.plans),
        }
      : undefined;
  }
  async select(
    definition: SetDefinition,
    instance: SetInstance,
    targets: OutputTarget[],
    data: PublicData,
  ): Promise<"presented" | "superseded"> {
    targets = structuredClone(targets);
    instance = structuredClone(instance);
    if (this.disposed) throw Error("Presentation controller is disposed");
    if (this.unconfirmed.length >= 2)
      throw Error("Renderer presentation state needs reconciliation");
    const intent = ++this.intent;
    this.pending?.abort();
    const abort = new AbortController();
    this.pending = abort;
    const fresh = () =>
      !this.disposed && this.intent === intent && !abort.signal.aborted;
    this.state = { state: "preparing", instanceId: instance.id };
    let candidate: Candidate | undefined;
    let swapped = false;
    let unlock: (() => void) | undefined;
    try {
      if (
        !targets.length ||
        targets.length > 2 ||
        new Set(targets.map((t) => t.id)).size !== targets.length
      )
        throw Error("Invalid output targets");
      // Every target compiles before preparation; missing portrait cannot partially take landscape.
      const plans = targets.map((t) =>
        compileSet(definition, instance, t, data),
      );
      const expected = JSON.stringify(plans);
      candidate = await this.presenter.prepare(plans, abort.signal);
      if (!fresh()) {
        candidate.dispose();
        candidate = undefined;
        return "superseded";
      }
      if (!candidate.id || JSON.stringify(candidate.plans) !== expected)
        throw Error("Prepared candidate does not match requested plan");
      const priorTake = this.takeTail;
      this.takeTail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await priorTake;
      if (!fresh()) {
        candidate.dispose();
        candidate = undefined;
        return "superseded";
      }
      this.state = { state: "taking", instanceId: instance.id };
      const receipt = await this.presenter.commit(candidate, {
        signal: abort.signal,
        swap: (action) => {
          if (!fresh() || swapped) return false;
          action();
          swapped = true;
          return true;
        },
      });
      if (!swapped) throw Error("Renderer did not perform an authorized take");
      if (
        receipt.candidateId !== candidate.id ||
        !Number.isSafeInteger(receipt.frame) ||
        receipt.frame < 0 ||
        receipt.outputs.length !== targets.length ||
        new Set(receipt.outputs).size !== targets.length ||
        targets.some((t) => !receipt.outputs.includes(t.id))
      )
        throw Error("Invalid presentation receipt");
      // A selection can supersede this request after its atomic take but before its
      // presented receipt. Retain it as current ownership until the newer take completes.
      if (this.disposed) {
        candidate.dispose();
        candidate = undefined;
        return "superseded";
      }
      for (const c of this.unconfirmed) c.dispose();
      this.unconfirmed = [];
      const previous = this.program;
      this.program = { candidate, receipt, instanceId: instance.id };
      candidate = undefined;
      previous?.candidate.dispose();
      if (fresh()) {
        this.state = { state: "presented", instanceId: instance.id };
        this.pending = undefined;
        return "presented";
      }
      return "superseded";
    } catch (e) {
      if (candidate) {
        if (swapped && !this.disposed) this.unconfirmed.push(candidate);
        else candidate.dispose();
      }
      if (!fresh()) return "superseded";
      this.pending = undefined;
      this.state = {
        state: "error",
        instanceId: instance.id,
        message: e instanceof Error ? e.message : String(e),
      };
      throw e;
    } finally {
      unlock?.();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.intent++;
    this.pending?.abort();
    this.program?.candidate.dispose();
    this.program = undefined;
    for (const c of this.unconfirmed) c.dispose();
    this.unconfirmed = [];
    this.state = { state: "idle" };
  }
}

import { finite, safeKey, type DataValue, type PublicData } from "./data";
export interface ReactionRule {
  id: string;
  channel: string;
  path: string[];
  condition:
    | { op: "above"; value: number }
    | { op: "equals"; value: string | number | boolean };
  trigger: "rising" | "initialOrRising";
  policy: "automatic" | "hostApproved";
  action: { type: "cue.select"; cue: string };
}
export interface ProposedAction {
  id: string;
  ruleId: string;
  action: { type: "cue.select"; cue: string };
  channel: string;
  generation: number;
  revision: number;
  approvalRequired: boolean;
}
/** Visual bindings don't execute actions. Explicit creator-authored rules emit
 * proposals for a separate authorized show controller. No actions come from payloads. */
export class ReactionRules {
  private previous = new Map<
    string,
    { generation: number; revision: number; match: boolean }
  >();
  private pending = new Map<string, ProposedAction>();
  private rules: ReactionRule[];
  constructor(rules: ReactionRule[], channels: string[], cues: string[]) {
    if (rules.length > 64) throw Error("Too many reaction rules");
    const ids = new Set<string>();
    for (const r of rules) {
      if (
        !safeKey(r.id) ||
        ids.has(r.id) ||
        !channels.includes(r.channel) ||
        r.path.length > 12 ||
        r.path.some((k) => !safeKey(k) && !/^\d{1,3}$/.test(k)) ||
        !["rising", "initialOrRising"].includes(r.trigger) ||
        !["automatic", "hostApproved"].includes(r.policy) ||
        r.action.type !== "cue.select" ||
        !cues.includes(r.action.cue)
      )
        throw Error("Invalid reaction rule");
      ids.add(r.id);
      if (r.condition.op === "above") finite(r.condition.value, -1e12, 1e12);
      else if (
        r.condition.op !== "equals" ||
        !["string", "number", "boolean"].includes(typeof r.condition.value)
      )
        throw Error("Invalid rule condition");
    }
    this.rules = structuredClone(rules);
  }
  evaluate(data: PublicData): ProposedAction[] {
    const emitted: ProposedAction[] = [];
    for (const r of this.rules) {
      const c = data[r.channel];
      if (!c) continue;
      const previous = this.previous.get(r.id);
      // A pending host decision is tied to exactly the public revision it observed.
      for (const [id, p] of this.pending)
        if (
          p.ruleId === r.id &&
          (c.stale ||
            c.generation !== p.generation ||
            c.revision !== p.revision)
        )
          this.pending.delete(id);
      if (c.stale) continue;
      if (
        previous &&
        previous.generation === c.generation &&
        previous.revision >= c.revision
      )
        continue;
      let value: DataValue | undefined = c.value;
      for (const k of r.path) {
        if (
          value === null ||
          typeof value !== "object" ||
          !Object.prototype.hasOwnProperty.call(value, k)
        ) {
          value = undefined;
          break;
        }
        value = (value as Record<string, DataValue>)[k];
      }
      const match =
        r.condition.op === "above"
          ? typeof value === "number" && value > r.condition.value
          : value === r.condition.value;
      const baseline =
        previous?.generation === c.generation ? previous : undefined;
      this.previous.set(r.id, {
        generation: c.generation,
        revision: c.revision,
        match,
      });
      if (
        !match ||
        baseline?.match ||
        (!baseline && r.trigger !== "initialOrRising")
      )
        continue;
      const proposal: ProposedAction = {
        id: `${r.id}:${c.generation}:${c.revision}`,
        ruleId: r.id,
        action: { ...r.action },
        channel: r.channel,
        generation: c.generation,
        revision: c.revision,
        approvalRequired: r.policy === "hostApproved",
      };
      if (proposal.approvalRequired) {
        if (this.pending.size >= 64) throw Error("Approval queue is full");
        this.pending.set(proposal.id, proposal);
      }
      emitted.push(structuredClone(proposal));
    }
    return emitted;
  }
  approve(id: string, data: PublicData): ProposedAction {
    const p = this.pending.get(id);
    if (!p) throw Error("Unknown or consumed approval");
    this.pending.delete(id);
    const c = data[p.channel];
    if (
      !c ||
      c.stale ||
      c.generation !== p.generation ||
      c.revision !== p.revision
    )
      throw Error("Approval is no longer current");
    return { ...p, action: { ...p.action }, approvalRequired: false };
  }
  reject(id: string): void {
    this.pending.delete(id);
  }
}

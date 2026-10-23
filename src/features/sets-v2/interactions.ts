import { finite, safeKey, type DataValue, type ValueSchema } from "./data";
export interface PollDefinition {
  id: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  allowChange: boolean;
  maxVoters: number;
}
export interface Vote {
  round: number;
  sequence: number;
  choice: string;
}
export interface PollPublic {
  id: string;
  round: number;
  question: string;
  open: boolean;
  revealed: boolean;
  choices: Array<{ id: string; label: string }>;
  results: null | {
    total: number;
    choices: Array<{ id: string; count: number; fraction: number }>;
    leaders: string[];
  };
}
/** Principal identity comes from the trusted audience transport. Ballots never reach a render plan. */
export class PollSession {
  private ballots = new Map<string, Vote>();
  private round = 1;
  private open = false;
  private revealed = false;
  private config: PollDefinition;
  get definition(): PollDefinition {
    return structuredClone(this.config);
  }
  constructor(definition: PollDefinition) {
    if (
      !safeKey(definition.id) ||
      !definition.question ||
      definition.question.length > 240 ||
      definition.choices.length < 2 ||
      definition.choices.length > 12 ||
      typeof definition.allowChange !== "boolean"
    )
      throw Error("Invalid poll definition");
    finite(definition.maxVoters, 1, 100000);
    if (!Number.isInteger(definition.maxVoters))
      throw Error("Invalid voter limit");
    const ids = new Set<string>();
    for (const c of definition.choices) {
      if (!safeKey(c.id) || ids.has(c.id) || !c.label || c.label.length > 120)
        throw Error("Invalid poll choice");
      ids.add(c.id);
    }
    this.config = structuredClone(definition);
  }
  /** Operator-only methods: expose through an authorized controller, never bind raw payloads to these. */
  start(): void {
    if (this.revealed) throw Error("Reset the poll before reopening");
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  reveal(): void {
    if (this.open) throw Error("Close voting before revealing");
    this.revealed = true;
  }
  reset(): void {
    this.round++;
    this.ballots.clear();
    this.open = false;
    this.revealed = false;
  }
  cast(principalId: string, vote: Vote): "accepted" | "duplicate" | "closed" {
    if (
      !principalId ||
      principalId.length > 160 ||
      !Number.isSafeInteger(vote.round) ||
      !Number.isSafeInteger(vote.sequence) ||
      vote.sequence < 1 ||
      !this.config.choices.some((c) => c.id === vote.choice)
    )
      throw Error("Invalid ballot");
    if (vote.round !== this.round || !this.open) return "closed";
    const prior = this.ballots.get(principalId);
    if (prior && vote.sequence <= prior.sequence) return "duplicate";
    if (prior && !this.config.allowChange) return "duplicate";
    if (!prior && this.ballots.size >= this.config.maxVoters)
      throw Error("Poll capacity reached");
    this.ballots.set(principalId, { ...vote });
    return "accepted";
  }
  publicState(): PollPublic {
    const p: PollPublic = {
      id: this.config.id,
      round: this.round,
      question: this.config.question,
      open: this.open,
      revealed: this.revealed,
      choices: structuredClone(this.config.choices),
      results: null,
    };
    if (this.revealed) {
      const counts = new Map(this.config.choices.map((c) => [c.id, 0]));
      for (const v of this.ballots.values())
        counts.set(v.choice, counts.get(v.choice)! + 1);
      const total = this.ballots.size;
      const max = Math.max(...counts.values());
      p.results = {
        total,
        choices: [...counts].map(([id, count]) => ({
          id,
          count,
          fraction: total ? count / total : 0,
        })),
        leaders: total
          ? [...counts].filter(([, n]) => n === max).map(([id]) => id)
          : [],
      };
    }
    return p;
  }
  /** A renderer/data adapter receives only the public representation. */
  data(): DataValue {
    return JSON.parse(JSON.stringify(this.publicState())) as DataValue;
  }
}
export const pollDataSchema: ValueSchema = {
  type: "object",
  fields: {
    id: { type: "string", maxLength: 64 },
    round: { type: "number", min: 1, max: 1e9 },
    question: { type: "string", maxLength: 240 },
    open: { type: "boolean" },
    revealed: { type: "boolean" },
    choices: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        fields: {
          id: { type: "string", maxLength: 64 },
          label: { type: "string", maxLength: 120 },
        },
      },
    },
    results: {
      type: "object",
      nullable: true,
      fields: {
        total: { type: "number", min: 0, max: 100000 },
        choices: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            fields: {
              id: { type: "string", maxLength: 64 },
              count: { type: "number", min: 0, max: 100000 },
              fraction: { type: "number", min: 0, max: 1 },
            },
          },
        },
        leaders: {
          type: "array",
          maxItems: 12,
          items: { type: "string", maxLength: 64 },
        },
      },
    },
  },
};

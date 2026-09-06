export type PlannerProviderId = 'claude' | 'codex';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PlannerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export type PlannerAskResult =
  | {
    readonly ok: true;
    readonly text: string;
    readonly providerId: PlannerProviderId;
    readonly requestedModel: string;
    readonly resolvedModel: string | null;
    readonly reasoningEffort: ReasoningEffort;
    readonly usage: PlannerUsage;
  }
  | { readonly ok: false; readonly error: string };

export interface PlannerAdapter {
  readonly providerId: PlannerProviderId;
  ask(prompt: string): PlannerAskResult;
}

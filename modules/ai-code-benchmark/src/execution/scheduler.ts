export interface SchedulerOptions {
  readonly concurrency: number;
  readonly signal?: AbortSignal;
}

/** Bounded FIFO scheduling. Results retain input order even when workers finish out of order. */
export async function scheduleBounded<T, R>(items: readonly T[], worker: (item: T) => Promise<R>, options: SchedulerOptions): Promise<readonly (R | undefined)[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("Scheduler concurrency must be a positive integer.");
  const results: Array<R | undefined> = new Array(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) return;
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, runner));
  return results;
}

export class ExecutionTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) { super(`Observation timed out after ${timeoutMs}ms.`); this.name = "ExecutionTimeoutError"; }
}

const ABORT_CLEANUP_GRACE_MS = 10_000;

export async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Observation timeout must be a positive integer.");
  const controller = new AbortController();
  const cancel = (): void => controller.abort(parentSignal?.reason ?? new Error("Observation cancelled."));
  parentSignal?.addEventListener("abort", cancel, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const operationResult = operation(controller.signal).then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error })
  );
  const timeout = new Promise<{ readonly kind: "timeout"; readonly error: ExecutionTimeoutError }>((resolve) => {
    timer = setTimeout(() => { const error = new ExecutionTimeoutError(timeoutMs); controller.abort(error); resolve({ kind: "timeout", error }); }, timeoutMs);
  });
  try {
    if (parentSignal?.aborted) cancel();
    const result = await Promise.race([operationResult, timeout]);
    if (result.kind === "timeout") {
      // The deadline decides the observation outcome, but the provider adapter may
      // still be terminating its process tree and restoring benchmark-owned files.
      // Give that finally-path a bounded grace period before the runtime captures
      // the workspace; otherwise harness-created metadata can be misclassified as
      // an agent scope escape.
      await Promise.race([operationResult, new Promise<void>((resolve) => setTimeout(resolve, ABORT_CLEANUP_GRACE_MS))]);
      throw result.error;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
}

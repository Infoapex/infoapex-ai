import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskContext } from "../../src/context-provider/task-context.js";
import type { ContextProvider } from "../../src/context-provider/types.js";

describe("per-task context provider context", () => {
  it("requests a task brief and declared symbol lookups", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls);

    const context = await buildTaskContext({
      provider,
      taskDescription: "Implement invoice rounding",
      relevantSymbols: ["InvoiceTotal", "InvoiceTotal"]
    });

    assert.deepEqual(calls.sort(), ["brief:Implement invoice rounding", "find:InvoiceTotal", "impact:InvoiceTotal"]);
    assert.equal(context.source, "ai-code-control");
    assert.equal(context.brief.status, "OK");
    assert.equal(context.symbols.length, 1);
  });

  it("bounds provider output before it can be added to an engine prompt", async () => {
    const context = await buildTaskContext({
      provider: fakeProvider([]),
      taskDescription: "task",
      relevantSymbols: ["InvoiceTotal"],
      maximumCharacters: 500
    });

    assert.ok(JSON.stringify(context).length <= 500);
  });
});

function fakeProvider(calls: string[]): ContextProvider {
  return {
    kind: "ai-code-control",
    health: async () => ({ status: "OK", value: { available: true, version: "1.0.0", detail: null } }),
    brief: async (task) => {
      calls.push(`brief:${task}`);
      return { status: "OK", value: { summary: "A".repeat(5_000), relevantFiles: ["src/invoice.ts"] } };
    },
    findSymbol: async (symbol) => {
      calls.push(`find:${symbol}`);
      return { status: "OK", value: [{ symbol, file: "src/invoice.ts", line: 42 }] };
    },
    impact: async (symbol) => {
      calls.push(`impact:${symbol}`);
      return { status: "OK", value: { symbol, affectedFiles: ["src/invoice.ts"], riskNotes: ["verify rounding"] } };
    },
    refresh: async () => ({ status: "OK", value: { refreshed: true, detail: null } })
  };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskEvidenceTraceability } from "../../src/evidence/task-traceability.js";
import type { QualityGateResult } from "../../src/runner/quality-gate.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

describe("task evidence traceability", () => {
  it("preserves criterionId, gateId, evidenceContract, and the executed command id", () => {
    const command: QualityGateResult = {
      id: "configured-test-gate",
      executable: "npm",
      args: ["test"],
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      outputTruncated: false,
      redacted: false,
      outputSha256: "a".repeat(64),
      failureClass: null
    };
    const taskTraceability = buildTaskEvidenceTraceability({
      id: "TASK-01",
      traceability: {
        acceptanceCriteria: [{ criterionId: "AC-01", text: "Tests pass." }],
        gates: [{
          gateId: "G-01",
          command: "configured-test-gate",
          evidenceContract: "Exit code is zero.",
          criterionIds: ["AC-01"]
        }]
      }
    }, [command]);

    assert.deepEqual(taskTraceability, {
      taskId: "TASK-01",
      criterionIds: ["AC-01"],
      gates: [{
        gateId: "G-01",
        criterionIds: ["AC-01"],
        evidenceContract: "Exit code is zero.",
        commandId: "configured-test-gate"
      }]
    });

    const evidence = {
      schemaVersion: "1.1",
      runId: "run-trace",
      engine: { name: "fake", version: "0.0.0", adapterVersion: "0.0.0" },
      input: { uncachedTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalReportedTokens: 1 },
      output: { standardTokens: 1, reasoningTokens: null, totalReportedTokens: 1 },
      cost: { reportedCostUsd: null, estimatedCostUsd: null, currency: null },
      commands: [{ id: command.id, executable: command.executable, args: command.args, exitCode: 0, durationMs: 10 }],
      artifacts: [],
      taskTraceability
    };
    assert.equal(SchemaRegistry.load().validate("evidence.schema.json", evidence).valid, true);
  });

  it("keeps legacy tasks on evidence v1.0 by returning no synthetic trace", () => {
    assert.equal(buildTaskEvidenceTraceability({ id: "TASK-LEGACY" }, []), null);
  });
});

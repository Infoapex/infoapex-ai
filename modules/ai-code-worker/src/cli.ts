#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { estimateClaudePercentFromTokens } from "./benchmark/claude-calibration.js";
import { estimateUsageForPlan, type PlanTaskShape, type PlanUsageEstimate } from "./benchmark/estimate.js";
import { findLatestCodexRolloutPath, readCodexSessionLog } from "./benchmark/read-codex-session.js";
import { resolveUsageCheckpointLogPath, UsageCheckpointLog, type UsageCheckpointTokens } from "./benchmark/usage-checkpoint.js";
import { runCompile } from "./compile/compile.js";
import { AGENTS_MD_BLOCK_VERSION, proposeAgentsMdBlock, writeAgentsMdBlock } from "./config/agents-md-block.js";
import { initProjectConfig, updateProjectConfig } from "./config/init.js";
import { installShims } from "./config/shims.js";
import { loadProjectConfig } from "./config/project-config.js";
import { resolveContextProvider } from "./context-provider/resolve.js";
import type { ContextProviderCallResult } from "./context-provider/types.js";
import { buildTaskContext, type TaskContext } from "./context-provider/task-context.js";
import { writeRedactedHandoff } from "./report/export-artifacts.js";
import { createClaudeIndependentReviewer, createCodexIndependentReviewer } from "./review/independent-reviewer-cli.js";
import { createClaudeRepairExecutor } from "./repair/execute-claude-repair-cycle.js";
import { createCodexRepairExecutor } from "./repair/execute-codex-repair-cycle.js";
import { resolveStateRoot } from "./state/state-root.js";
import type { ReviewPromptTask } from "./review/build-review-prompt.js";
import { runDoctor } from "./doctor/doctor.js";
import { runClaude, claudeConfig, claudeAdapterConfigFromProject } from "./run/claude-run.js";
import { runCodex, codexConfig, codexAdapterConfigFromProject } from "./run/codex-run.js";
import { runFake } from "./run/fake-run.js";
import { ClaudeCliAdapter } from "./engines/claude-cli.js";
import { CodexCliAdapter } from "./engines/codex-cli.js";
import type { ProjectConfig } from "./config/project-config.js";
import { runStatus } from "./status/status.js";
import { findPlannerHandoffRunId, publishWorkerFeedback } from "./integration/apex-handoff.js";
import { runReadOnlyReview } from "./review/review-command.js";
import {
  evaluateCodexSandboxPolicy,
  type CodexDangerFullAccessApproval
} from "./policy/codex-sandbox-policy.js";
import type { ExecutionBackendBinding, TrustedLocalAuthorizationInput } from "./execution/environment.js";

const args = process.argv.slice(2);
const command = args[0];

if (command === "review") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const inputPath = readOption("--input");
  const engine = readOption("--engine") ?? "fake";
  const fixturePath = readOption("--fixture") ?? undefined;
  const executable = readOption("--executable") ?? undefined;
  const model = readOption("--model") ?? undefined;
  const asJson = args.includes("--json");

  if (!inputPath || (engine !== "fake" && engine !== "codex" && engine !== "claude")) {
    console.error("Usage: ai-code-worker review --repo <path> --input <request.json> --engine <fake|codex|claude> [--fixture <review.json>] [--json]");
    process.exitCode = 1;
  } else {
    const result = runReadOnlyReview({
      repositoryPath,
      inputPath,
      engine,
      ...(fixturePath ? { fixturePath } : {}),
      ...(executable ? { executable } : {}),
      ...(model ? { model } : {})
    });
    console.log(asJson ? JSON.stringify(result, null, 2) : `ai-code-worker review: ${result.status}`);
    process.exitCode = result.status === "DONE" ? 0 : 2;
  }
} else if (command === "init") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const asJson = args.includes("--json");
  const force = args.includes("--force");
  const engines = (readOption("--engines") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const writeAgentsMd = args.includes("--write-agents-md");
  const installShimsFlag = args.includes("--install-shims");
  const result = initProjectConfig(repositoryPath, { force, engines });
  // AGENTS.md proposal/write and shim installation are independent of whether
  // config.json needed scaffolding - a repeat `init` (config already exists) is
  // exactly the "pick up a newer proposed block" / "add shims I skipped the first
  // time" scenario docs/ONBOARDING.md documents, not a no-op. Both are read-only
  // (propose) or explicitly flag-gated (write/install) either way.
  const agentsMdProposal = writeAgentsMd ? writeAgentsMdBlock(repositoryPath) : proposeAgentsMdBlock(repositoryPath);
  const shims = installShimsFlag ? installShims(repositoryPath, engines) : null;

  if (asJson) {
    console.log(JSON.stringify({ ...result, agentsMd: agentsMdProposal, ...(shims ? { shims } : {}) }, null, 2));
  } else {
    console.log(`ai-code-worker init: ${result.status}`);
    if (result.status === "CREATED") {
      console.log(`  ${result.configPath}`);
      console.log(`  ${result.readmePath}`);
    } else {
      console.log(`  ${result.configPath} (pass --force to overwrite, or use "ai-code-worker update")`);
    }
    if ("content" in agentsMdProposal) {
      if (agentsMdProposal.state === "CURRENT") {
        console.log("AGENTS.md already has the current ai-code-worker block.");
      } else {
        console.log(
          agentsMdProposal.state === "STALE"
            ? `Proposed AGENTS.md block update (existing block is v${agentsMdProposal.existingVersion}, current is v${AGENTS_MD_BLOCK_VERSION} - pass --write-agents-md to replace it):`
            : "Proposed AGENTS.md block (pass --write-agents-md to add it):"
        );
        console.log(agentsMdProposal.content);
      }
    } else {
      console.log(`AGENTS.md: ${agentsMdProposal.status} (${agentsMdProposal.path})`);
    }
    if (shims) {
      console.log(`Shims installed: ${shims.installed.join(", ") || "none"}${shims.skipped.length > 0 ? ` (skipped, already present: ${shims.skipped.join(", ")})` : ""}`);
    }
  }

  process.exitCode = result.status === "ALREADY_EXISTS" ? 1 : 0;
} else if (command === "update") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const asJson = args.includes("--json");
  const result = updateProjectConfig(repositoryPath);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "MISSING") {
    console.log(`ai-code-worker update: MISSING (run "ai-code-worker init" first)`);
  } else if (result.status === "UNCHANGED") {
    console.log(`ai-code-worker update: UNCHANGED (already up to date)`);
  } else {
    console.log(`ai-code-worker update: UPDATED`);
    console.log(`  added keys: ${result.addedKeys.join(", ")}`);
  }

  process.exitCode = result.status === "MISSING" ? 1 : 0;
} else if (command === "doctor") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const engineOption = readOption("--engine");
  const claudeExecutable = readOption("--claude-executable") ?? undefined;
  const codexExecutable = readOption("--codex-executable") ?? undefined;
  const claudeModel = readOption("--claude-model") ?? undefined;
  const codexModel = readOption("--codex-model") ?? undefined;
  const claudePermissionMode = readOption("--claude-permission-mode") ?? undefined;
  const codexSandboxMode = readOption("--codex-sandbox") ?? undefined;
  const codexDangerFullAccessApproval = readCodexDangerFullAccessApproval();
  const trustedLocalAuthorization = readTrustedLocalAuthorization();
  const claudeBareMode = args.includes("--claude-bare") ? true : undefined;
  const claudeDangerouslySkipPermissions = args.includes("--claude-dangerously-skip-permissions") ? true : undefined;
  const asJson = args.includes("--json");

  if (engineOption && engineOption !== "fake" && engineOption !== "codex" && engineOption !== "claude") {
    console.error("Unsupported --engine value. Use fake, codex, or claude.");
    process.exitCode = 1;
  } else {
    const report = runDoctor({
      repositoryPath,
      engine: engineOption as "fake" | "codex" | "claude" | undefined,
      claudeExecutable,
      codexExecutable,
      claudeModel,
      codexModel,
      claudeBareMode,
      claudeDangerouslySkipPermissions,
      claudePermissionMode: isClaudePermissionMode(claudePermissionMode) ? claudePermissionMode : undefined,
      codexSandboxMode: isCodexSandboxMode(codexSandboxMode) ? codexSandboxMode : undefined,
      codexDangerFullAccessApproval,
      trustedLocalAuthorization
    });

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ai-code-worker doctor: ${report.status}`);
      for (const finding of report.findings) {
        console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
      }
    }

    process.exitCode = report.status === "BLOCKED" ? 2 : 0;
  }
} else if (command === "status") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const runId = readOption("--run-id");
  const asJson = args.includes("--json");

  if (!runId) {
    console.error("Missing required option: --run-id <id>");
    process.exitCode = 1;
  } else {
    const report = runStatus({ repositoryPath, runId });

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ai-code-worker status: ${report.status}`);
      console.log(`run ${runId}: ${report.run.status}`);
      for (const finding of report.findings) {
        console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
      }
    }

    process.exitCode = report.status === "BLOCKED" ? 2 : 0;
  }
} else if (command === "compile") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const planPath = readOption("--plan");
  const runId = readOption("--run-id") ?? undefined;
  const trustedLocalAuthorization = readTrustedLocalAuthorization();
  const asJson = args.includes("--json");

  if (!planPath) {
    console.error("Missing required option: --plan <path>");
    process.exitCode = 1;
  } else {
    const report = runCompile({ repositoryPath, planPath, runId, trustedLocalAuthorization });

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ai-code-worker compile: ${report.status}`);
      if (report.runId) {
        console.log(`run ${report.runId}: ${report.manifestSha256}`);
      }
      for (const finding of report.findings) {
        console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
      }
    }

    process.exitCode = report.status === "BLOCKED" ? 2 : 0;
  }
} else if (command === "run") {
  const repositoryPath = readOption("--repo") ?? process.cwd();
  const planPath = readOption("--plan");
  const runId = readOption("--run-id") ?? undefined;
  let engine = readOption("--engine") ?? "fake";
  const requestedEngine = engine;
  const fallbackEngine = readOption("--fallback-engine") ?? undefined;
  const claudeExecutable = readOption("--claude-executable") ?? undefined;
  const codexExecutable = readOption("--codex-executable") ?? undefined;
  const claudeModel = readOption("--claude-model") ?? undefined;
  const codexModel = readOption("--codex-model") ?? undefined;
  const claudePermissionMode = readOption("--claude-permission-mode") ?? undefined;
  const codexSandboxMode = readOption("--codex-sandbox") ?? undefined;
  const codexDangerFullAccessApproval = readCodexDangerFullAccessApproval();
  const trustedLocalAuthorization = readTrustedLocalAuthorization();
  const claudeBareMode = args.includes("--claude-bare") ? true : undefined;
  const claudeDangerouslySkipPermissions = args.includes("--claude-dangerously-skip-permissions") ? true : undefined;
  const asJson = args.includes("--json");

  if (!planPath) {
    console.error("Missing required option: --plan <path>");
    process.exitCode = 1;
  } else if (engine !== "fake" && engine !== "codex" && engine !== "claude") {
    const report = {
      status: "BLOCKED",
      findings: [
        {
          severity: "blocker",
          code: "ENGINE_UNAVAILABLE",
          message: "Unsupported run engine. Use --engine fake, --engine codex, or --engine claude."
        }
      ]
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("ai-code-worker run: BLOCKED");
      console.log("BLOCKER ENGINE_UNAVAILABLE: Unsupported run engine. Use --engine fake, --engine codex, or --engine claude.");
    }

    process.exitCode = 2;
  } else if (fallbackEngine !== undefined && fallbackEngine !== "codex" && fallbackEngine !== "claude") {
    const report = {
      status: "BLOCKED",
      findings: [
        {
          severity: "blocker",
          code: "FALLBACK_ENGINE_UNAVAILABLE",
          message: "Unsupported --fallback-engine value. Use --fallback-engine codex or --fallback-engine claude."
        }
      ]
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("ai-code-worker run: BLOCKED");
      console.log("BLOCKER FALLBACK_ENGINE_UNAVAILABLE: Unsupported --fallback-engine value. Use --fallback-engine codex or --fallback-engine claude.");
    }

    process.exitCode = 2;
  } else {
    const checkpointLog = new UsageCheckpointLog(resolveUsageCheckpointLogPath(repositoryPath));

    // AICW-ADR-001 §5 / IMPLEMENTATION-PLAN §13 flow items 1-2: detect the provider
    // from project config and run health+brief before compilation. `contextProvider`
    // defaults to "none" (NoneContextProvider), so this resolves and awaits two
    // already-resolved UNAVAILABLE promises for every repository that hasn't opted
    // in - no behavior change, matching the stage 1 exit criterion. Health/brief are
    // advisory only: a failing or absent provider never blocks the run (no blocking
    // policy exists yet - out of scope for this stage, see docs/BENCHMARKS.md).
    const projectConfig = loadProjectConfig(repositoryPath);

    // Opt-in engine failover (--fallback-engine): only for the one signal that
    // is reliably distinguishable from "the task itself failed" - the engine
    // being unavailable *before any task starts* (CLI missing, untested
    // version, smoke test failure; see doctor()'s findings). Deliberately
    // does NOT retry a task mid-run on a different engine after a FAILED
    // agent-result: today every such failure collapses into the same
    // generic failures[].class "engine" bucket regardless of cause (rate
    // limit, quota, a genuine bug, a malformed response), so auto-switching
    // engines on that signal would risk silently masking a real failure as
    // "must have been exhausted". If that ever becomes reliably detectable,
    // mid-run failover is the natural next step - not built yet.
    let engineFallbackTriggered = false;
    if ((engine === "codex" || engine === "claude") && fallbackEngine && fallbackEngine !== engine) {
      const primaryAvailable = checkEngineAvailable(engine, projectConfig, {
        executable: engine === "codex" ? codexExecutable : claudeExecutable,
        codexSandboxMode: isCodexSandboxMode(codexSandboxMode) ? codexSandboxMode : undefined,
        codexDangerFullAccessApproval
      });
      const primaryPolicyBlocked = engine === "codex" && isCodexSandboxPolicyBlocked(
        projectConfig,
        isCodexSandboxMode(codexSandboxMode) ? codexSandboxMode : undefined,
        codexDangerFullAccessApproval
      );

      if (!primaryAvailable && !primaryPolicyBlocked) {
        const fallbackAvailable = checkEngineAvailable(fallbackEngine, projectConfig, {
          executable: fallbackEngine === "codex" ? codexExecutable : claudeExecutable,
          codexSandboxMode: isCodexSandboxMode(codexSandboxMode) ? codexSandboxMode : undefined,
          codexDangerFullAccessApproval
        });

        if (fallbackAvailable) {
          console.error(`ai-code-worker run: engine "${engine}" is unavailable, falling back to "${fallbackEngine}".`);
          engine = fallbackEngine;
          engineFallbackTriggered = true;
        }
        // else: leave engine unchanged. runClaude/runCodex's own doctor()
        // check below reports the precise BLOCKER (version/smoke-test/etc.)
        // for the originally requested engine - the same detail a caller
        // gets today without --fallback-engine, not a vaguer "both failed".
      }
    }
    const engineTyped = engine as "fake" | "codex" | "claude";

    const contextProvider = resolveContextProvider(projectConfig, {
      repositoryRoot: repositoryPath
    });
    const contextProviderHealth = await contextProvider.health();
    const contextProviderBrief = await contextProvider.brief(planPath);
    // Compile is deterministic (same runId derives from planSha256+headCommit when
    // --run-id is omitted) and idempotent (readExistingRun short-circuits a repeat
    // call), so previewing it here to get the manifest/runId for the estimate and
    // run-level checkpoints is safe - runFake/runClaude/runCodex below compile again
    // internally and land on the identical run.
    const preview = runCompile({ repositoryPath, planPath, runId, trustedLocalAuthorization });
    const effectiveRunId = preview.runId ?? runId ?? null;

    // Flow item 3 (deferred in stage 2 of Part B / Phase 4 - see docs/BENCHMARKS.md):
    // find-symbol/impact-analysis per task, wired now WITHOUT inventing a symbol-
    // identification heuristic. ai-code-worker still cannot derive "the symbols this
    // task touches" from a file path or acceptance-criteria text on its own - that
    // stays out of scope. Instead, a task may explicitly declare `relevantSymbols` in
    // the plan (the plan author already knows the code far better than any heuristic
    // would guess), and those declared symbols get looked up for real. A plan that
    // never declares any gets an empty list here - unchanged behavior.
    const relevantSymbols = preview.state.manifestPath ? readManifestRelevantSymbols(preview.state.manifestPath) : [];
    const contextProviderSymbols =
      contextProvider.kind !== "none" && relevantSymbols.length > 0
        ? await lookupContextProviderSymbols(contextProvider, relevantSymbols)
        : null;
    const taskContexts =
      contextProvider.kind !== "none" && preview.state.manifestPath
        ? await buildTaskContexts(contextProvider, preview.state.manifestPath)
        : null;

    const preRunEstimate =
      !args.includes("--no-estimate") && preview.status === "PASS" && preview.state.manifestPath
        ? estimateUsageForPlan({
            tasks: readManifestTaskShapes(preview.state.manifestPath),
            history: checkpointLog.read().checkpoints
          })
        : null;

    // Human mode prints the estimate up front, before the run starts - that's when
    // it's useful. JSON mode folds it into the single final report object instead
    // (below) so stdout stays one parseable JSON value, matching every other command
    // here and every existing consumer of `run --json`.
    if (preRunEstimate && !asJson) {
      printPreRunEstimate(preRunEstimate, false);
    }

    if (effectiveRunId) {
      checkpointLog.append({
        checkpointId: `${effectiveRunId}-run-start`,
        runId: effectiveRunId,
        scope: "run",
        engine: engineTyped,
        phase: "start",
        createdAt: new Date().toISOString(),
        ...codexSessionCrossCheck(engineTyped)
      });
    }

    // Opt-in real independent review (todo.md #9): --independent-review only has an
    // effect for --engine claude|codex with a compiled manifest. Repair now
    // actually dispatches the same engine to fix blocking findings (todo.md
    // #13's real-engine slice) - a review with blocking findings attempts a
    // bounded number of real repair cycles before surfacing findings and
    // blocking the run. Absent the flag, behavior is byte-identical to
    // before this existed.
    const independentReviewBase = readManifestReviewBase(preview.state.manifestPath);
    const repairStateRoot = resolveStateRoot({ repoRoot: repositoryPath, configuredStateRoot: projectConfig?.stateRoot ?? null }).path;

    // Cross-engine review by default when --independent-review is on: the
    // writer's own engine reviewing its own work has the same self-grading
    // problem a human self-review has (see the ai-code-planner design
    // record's reviewer-independence principle). Falls back to same-engine
    // review, with a visible notice, only when the other engine's CLI
    // genuinely isn't available - never silently, and never in a way that
    // blocks a run that would otherwise succeed.
    let reviewEngine: "codex" | "claude" | null = null;
    if (args.includes("--independent-review") && independentReviewBase && (engine === "codex" || engine === "claude")) {
      const otherEngine = engine === "codex" ? "claude" : "codex";
      const otherAvailable = checkEngineAvailable(otherEngine, projectConfig, {
        executable: otherEngine === "codex" ? codexExecutable : claudeExecutable,
        codexSandboxMode: isCodexSandboxMode(codexSandboxMode) ? codexSandboxMode : undefined,
        codexDangerFullAccessApproval
      });

      if (otherAvailable) {
        reviewEngine = otherEngine;
      } else {
        console.error(`ai-code-worker run: cross-engine review unavailable ("${otherEngine}" not usable), reviewing with "${engine}" instead.`);
        reviewEngine = engine;
      }
    }

    // One reviewer instance, reused both as the initial reviewer and as the
    // re-review the repair executor runs after each cycle - so a repair
    // cycle's "is it fixed now" check asks the exact same question, the
    // exact same way, as the check that triggered repair in the first
    // place. Only the chosen reviewEngine's reviewer is constructed - no
    // point spawning a doctor/version check for the one that was rejected.
    const chosenReviewer =
      reviewEngine === "codex" && independentReviewBase
        ? createCodexIndependentReviewer({
            repositoryPath,
            baseCommit: independentReviewBase.baseCommit,
            tasks: independentReviewBase.tasks,
            config: { ...(codexExecutable !== undefined ? { executable: codexExecutable } : {}) }
          })
        : reviewEngine === "claude" && independentReviewBase
        ? createClaudeIndependentReviewer({
            repositoryPath,
            baseCommit: independentReviewBase.baseCommit,
            tasks: independentReviewBase.tasks,
            config: { ...(claudeExecutable !== undefined ? { executable: claudeExecutable } : {}) }
          })
        : null;

    const independentReviewCodex =
      args.includes("--independent-review") && engine === "codex" && independentReviewBase && chosenReviewer
        ? {
            reviewer: chosenReviewer,
            executeRepairCycle: (repairBaseCommit: string, execution: ExecutionBackendBinding) =>
              createCodexRepairExecutor({
                repositoryPath,
                stateRoot: repairStateRoot,
                runId: effectiveRunId ?? "unknown-run",
                manifestSha256: preview.manifestSha256 ?? "",
                baseCommit: repairBaseCommit,
                projectConfig,
                adapterConfig: {
                  ...(codexExecutable !== undefined ? { executable: codexExecutable } : {}),
                  ...(isCodexSandboxMode(codexSandboxMode) ? { sandboxMode: codexSandboxMode } : {}),
                  ...(codexDangerFullAccessApproval ? { dangerFullAccessApproval: codexDangerFullAccessApproval } : {}),
                  execution
                },
                reviewer: chosenReviewer
              })
          }
        : undefined;
    const independentReviewClaude =
      args.includes("--independent-review") && engine === "claude" && independentReviewBase && chosenReviewer
        ? {
            reviewer: chosenReviewer,
            executeRepairCycle: (repairBaseCommit: string, execution: ExecutionBackendBinding) =>
              createClaudeRepairExecutor({
                repositoryPath,
                stateRoot: repairStateRoot,
                runId: effectiveRunId ?? "unknown-run",
                manifestSha256: preview.manifestSha256 ?? "",
                baseCommit: repairBaseCommit,
                projectConfig,
                adapterConfig: {
                  ...(claudeExecutable !== undefined ? { executable: claudeExecutable } : {}),
                  execution
                },
                reviewer: chosenReviewer
              })
          }
        : undefined;

    const report = engine === "codex"
      ? runCodex({
          repositoryPath,
          planPath,
          runId,
          trustedLocalAuthorization,
          adapterConfig: {
            ...(codexExecutable !== undefined ? { executable: codexExecutable } : {}),
            ...(codexModel !== undefined ? { defaultModel: codexModel } : {}),
            ...(isCodexSandboxMode(codexSandboxMode) ? { sandboxMode: codexSandboxMode } : {}),
            ...(codexDangerFullAccessApproval ? { dangerFullAccessApproval: codexDangerFullAccessApproval } : {})
          },
          ...(independentReviewCodex ? { independentReview: independentReviewCodex } : {}),
          ...(taskContexts ? { taskContexts } : {})
        })
      : engine === "claude"
      ? runClaude({
          repositoryPath,
          planPath,
          runId,
          trustedLocalAuthorization,
          adapterConfig: {
            ...(claudeExecutable !== undefined ? { executable: claudeExecutable } : {}),
            ...(claudeModel !== undefined ? { defaultModel: claudeModel } : {}),
            ...(isClaudePermissionMode(claudePermissionMode) ? { permissionMode: claudePermissionMode } : {}),
            ...(claudeBareMode !== undefined ? { bareMode: claudeBareMode } : {}),
            ...(claudeDangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions: claudeDangerouslySkipPermissions } : {})
          },
          codexAdapterConfig: {
            ...(codexExecutable !== undefined ? { executable: codexExecutable } : {}),
            ...(codexModel !== undefined ? { defaultModel: codexModel } : {}),
            ...(isCodexSandboxMode(codexSandboxMode) ? { sandboxMode: codexSandboxMode } : {}),
            ...(codexDangerFullAccessApproval ? { dangerFullAccessApproval: codexDangerFullAccessApproval } : {})
          },
          ...(independentReviewClaude ? { independentReview: independentReviewClaude } : {}),
          ...(taskContexts ? { taskContexts } : {})
        })
      : runFake({ repositoryPath, planPath, runId });

    if (effectiveRunId) {
      const tokens = usageTotalsToTokens(report.usageTotals);
      const tokenSum = sumTokensOrNull(tokens);

      checkpointLog.append({
        checkpointId: `${effectiveRunId}-run-end`,
        runId: effectiveRunId,
        scope: "run",
        engine: engineTyped,
        phase: "end",
        createdAt: new Date().toISOString(),
        tokens,
        // Claude has no local %5h/%weekly reading to cross-check against (see
        // claude-calibration.ts) - this is the only percent signal available for it,
        // and must never be conflated with a real reading (percentUsedReported).
        percentUsedEstimated: engineTyped === "claude" && tokenSum !== null ? estimateClaudePercentFromTokens(tokenSum).percent : null,
        ...codexSessionCrossCheck(engineTyped)
      });
    }

    // Flow item 10: refresh only after integration (i.e. a DONE run), never from a
    // BLOCKED run or a parallel task worktree - this call site is the run-level
    // outcome, not inside any of the three runners.
    const contextProviderRefresh =
      report.status === "DONE" ? await contextProvider.refresh() : null;

    const contextProviderSummary =
      contextProvider.kind === "none"
        ? null
        : {
            kind: contextProvider.kind,
            health: contextProviderHealth,
            brief: contextProviderBrief,
            refresh: contextProviderRefresh,
            ...(contextProviderSymbols ? { symbols: contextProviderSymbols } : {})
          };

    // Flow item 9 + the "regulă configurată" invariant: only when the provider is
    // active AND the project has explicitly opted in with `handoffExport: true`.
    const handoffExport =
      contextProvider.kind !== "none" && projectConfig?.handoffExport === true && effectiveRunId
        ? writeRedactedHandoff({
            repositoryPath,
            runId: effectiveRunId,
            status: report.status,
            executedTasks: report.executedTasks,
            findings: report.findings,
            usageTotals: report.usageTotals,
            contextProviderKind: contextProvider.kind
          })
        : null;

    // Which engine actually wrote the code and which engine reviewed it -
    // may both differ from what --engine alone would suggest (fallback,
    // cross-engine review) - recorded explicitly so a caller never has to
    // infer this from log-reading.
    const engineProvenance = {
      requestedEngine,
      engineUsed: engineTyped,
      engineFallbackTriggered,
      reviewEngine
    };
    const apexHandoff = publishWorkerFeedback(repositoryPath, {
      runId: report.runId,
      status: report.status,
      executedTasks: report.executedTasks,
      findings: report.findings,
      engineProvenance,
      taskCommits: report.taskCommits,
      usageTotals: report.usageTotals,
      routing: preview.state.manifestPath ? readManifestRouting(preview.state.manifestPath) : null,
      channelRunId: readOption("--apex-run-id") ?? (planPath ? findPlannerHandoffRunId(repositoryPath, planPath) ?? undefined : undefined)
    });

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ...report,
            engineProvenance,
            ...(preRunEstimate ? { preRunEstimate } : {}),
            ...(contextProviderSummary ? { contextProvider: contextProviderSummary } : {}),
            ...(handoffExport ? { handoffExport } : {}),
            ...(apexHandoff ? { apexHandoff } : {})
          },
          null,
          2
        )
      );
    } else {
      console.log(`ai-code-worker run: ${report.status}`);
      if (report.runId) {
        console.log(`run ${report.runId}: ${report.executedTasks.join(", ")}`);
      }
      if (engineFallbackTriggered) {
        console.log(`engine: ${requestedEngine} -> ${engineTyped} (fallback)`);
      }
      if (reviewEngine) {
        console.log(`review engine: ${reviewEngine}`);
      }
      for (const finding of report.findings) {
        console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
      }
      if (contextProviderSummary) {
        console.log(
          `ai-code-control: health=${summarizeProviderCall(contextProviderSummary.health)} brief=${summarizeProviderCall(contextProviderSummary.brief)}${
            contextProviderSummary.refresh ? ` refresh=${summarizeProviderCall(contextProviderSummary.refresh)}` : ""
          }`
        );
        for (const lookup of contextProviderSummary.symbols ?? []) {
          console.log(`  symbol ${lookup.symbol}: find-symbol=${summarizeProviderCall(lookup.findSymbol)} impact=${summarizeProviderCall(lookup.impact)}`);
        }
      }
      if (handoffExport) {
        console.log(`handoff exported: ${handoffExport.path}`);
      }
      if (apexHandoff) {
        console.log(`apex feedback: ${apexHandoff}`);
      }
    }

    process.exitCode = report.status === "BLOCKED" ? 2 : 0;
  }
} else {
  console.error("Usage: ai-code-worker <init|update|doctor|status|compile|run|review> [--repo <path>] [--json]");
  process.exitCode = 1;
}

/** Whether an engine CLI is usable *before any task runs* - the one engine
 *  failure signal that is reliably distinguishable from "the task itself
 *  failed" today. See the --fallback-engine resolution comment in the run
 *  command for why this is deliberately not extended to mid-run failures. */
function checkEngineAvailable(
  kind: "codex" | "claude",
  projectConfig: ProjectConfig | null,
  overrides: {
    readonly executable?: string;
    readonly codexSandboxMode?: "workspace-write" | "danger-full-access";
    readonly codexDangerFullAccessApproval?: CodexDangerFullAccessApproval;
  }
): boolean {
  if (kind === "codex") {
    const adapter = new CodexCliAdapter(codexConfig({
      ...codexAdapterConfigFromProject(projectConfig),
      ...(overrides.executable !== undefined ? { executable: overrides.executable } : {}),
      ...(overrides.codexSandboxMode !== undefined ? { sandboxMode: overrides.codexSandboxMode } : {}),
      ...(overrides.codexDangerFullAccessApproval !== undefined
        ? { dangerFullAccessApproval: overrides.codexDangerFullAccessApproval }
        : {})
    }));
    return adapter.doctor().status === "PASS";
  }

  const adapter = new ClaudeCliAdapter(claudeConfig({
    ...claudeAdapterConfigFromProject(projectConfig),
    ...(overrides.executable !== undefined ? { executable: overrides.executable } : {})
  }));
  return adapter.doctor().status === "PASS";
}

function isCodexSandboxPolicyBlocked(
  projectConfig: ProjectConfig | null,
  sandboxMode: "workspace-write" | "danger-full-access" | undefined,
  approval: CodexDangerFullAccessApproval | undefined
): boolean {
  return evaluateCodexSandboxPolicy({
    sandboxMode: sandboxMode ?? projectConfig?.adapters?.codex?.sandboxMode,
    dangerFullAccessApproval: approval
  }).status === "BLOCKED";
}

function readOption(name: string): string | null {
  const index = args.indexOf(name);

  if (index < 0) {
    return null;
  }

  return args[index + 1] ?? null;
}

function isCodexSandboxMode(value: string | undefined): value is "workspace-write" | "danger-full-access" {
  return value === "workspace-write" || value === "danger-full-access";
}

function readCodexDangerFullAccessApproval(): CodexDangerFullAccessApproval | undefined {
  if (!args.includes("--approve-danger-full-access")) {
    return undefined;
  }

  return {
    approved: true,
    authorizedBy: readOption("--danger-full-access-authorized-by") ?? "",
    reason: readOption("--danger-full-access-reason") ?? "",
    approvedAt: readOption("--danger-full-access-approved-at") ?? "",
    source: "cli"
  };
}

function readTrustedLocalAuthorization(): TrustedLocalAuthorizationInput | undefined {
  if (!args.includes("--allow-trusted-local")) {
    return undefined;
  }

  return {
    approved: true,
    authorizedBy: readOption("--trusted-local-authorized-by") ?? "",
    reason: readOption("--trusted-local-reason") ?? "",
    approvedAt: readOption("--trusted-local-approved-at") ?? "",
    source: "cli"
  };
}

function isClaudePermissionMode(value: string | undefined): value is "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" {
  return value === "default" || value === "auto" || value === "plan" || value === "acceptEdits" || value === "bypassPermissions" || value === "dontAsk";
}

function summarizeProviderCall(result: ContextProviderCallResult<unknown>): string {
  return result.status === "OK" ? "OK" : `${result.status}(${result.reason})`;
}

function readManifestTaskShapes(manifestPath: string): readonly PlanTaskShape[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly tasks: readonly PlanTaskShape[] };
  return manifest.tasks;
}

function readManifestRouting(manifestPath: string): unknown {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly tasks: readonly { readonly id: string; readonly executionProfile?: string; readonly routing?: unknown }[];
  };
  return manifest.tasks
    .filter((task) => task.executionProfile !== undefined || task.routing !== undefined)
    .map((task) => ({ id: task.id, ...(task.executionProfile ? { executionProfile: task.executionProfile } : {}), ...(task.routing ? { routing: task.routing } : {}) }));
}

interface ManifestReviewBase {
  readonly baseCommit: string;
  readonly tasks: readonly ReviewPromptTask[];
}

function readManifestReviewBase(manifestPath: string | null): ManifestReviewBase | null {
  if (!manifestPath) {
    return null;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly base: { readonly commit: string };
    readonly tasks: readonly { readonly id: string; readonly acceptanceCriteria?: readonly string[] }[];
  };

  return {
    baseCommit: manifest.base.commit,
    tasks: manifest.tasks.map((task) => ({ id: task.id, acceptanceCriteria: task.acceptanceCriteria ?? [] }))
  };
}

function readManifestRelevantSymbols(manifestPath: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly tasks: readonly { readonly relevantSymbols?: readonly string[] }[];
  };

  return [...new Set(manifest.tasks.flatMap((task) => task.relevantSymbols ?? []))].sort();
}

interface ContextProviderSymbolLookup {
  readonly symbol: string;
  readonly findSymbol: ContextProviderCallResult<readonly unknown[]>;
  readonly impact: ContextProviderCallResult<unknown>;
}

async function lookupContextProviderSymbols(
  contextProvider: ReturnType<typeof resolveContextProvider>,
  symbols: readonly string[]
): Promise<readonly ContextProviderSymbolLookup[]> {
  const results: ContextProviderSymbolLookup[] = [];

  for (const symbol of symbols) {
    results.push({
      symbol,
      findSymbol: await contextProvider.findSymbol(symbol),
      impact: await contextProvider.impact(symbol)
    });
  }

  return results;
}

async function buildTaskContexts(
  contextProvider: ReturnType<typeof resolveContextProvider>,
  manifestPath: string
): Promise<Readonly<Record<string, TaskContext>>> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly goal?: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly role?: string;
      readonly acceptanceCriteria?: readonly string[];
      readonly requiredInputs?: readonly string[];
      readonly relevantSymbols?: readonly string[];
    }[];
  };

  const entries = await Promise.all(
    manifest.tasks.map(async (task) => {
      const description = [
        manifest.goal ? `Run goal: ${manifest.goal}` : null,
        `Task: ${task.id}${task.role ? ` (${task.role})` : ""}`,
        task.acceptanceCriteria?.length ? `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}` : null,
        task.requiredInputs?.length ? `Required inputs: ${task.requiredInputs.join(", ")}` : null
      ]
        .filter((part): part is string => part !== null)
        .join("\n");

      return [
        task.id,
        await buildTaskContext({
          provider: contextProvider,
          taskDescription: description,
          relevantSymbols: task.relevantSymbols
        })
      ] as const;
    })
  );

  return Object.fromEntries(entries);
}

function printPreRunEstimate(estimate: PlanUsageEstimate, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ preRunEstimate: estimate }, null, 2));
    return;
  }

  console.log("ai-code-worker pre-run usage estimate (pass --no-estimate to skip):");

  if (estimate.totalTokens) {
    console.log(
      `  total tokens: ${estimate.totalTokens.low}-${estimate.totalTokens.high} (median ${estimate.totalTokens.median})`
    );
  } else {
    console.log("  total tokens: no historical data yet for any task in this plan");
  }

  if (estimate.estimatedClaudePercent) {
    console.log(
      `  estimated %5h (claude, calibrated): ${estimate.estimatedClaudePercent.low.toFixed(1)}-${estimate.estimatedClaudePercent.high.toFixed(1)} (median ${estimate.estimatedClaudePercent.median.toFixed(1)})`
    );
  }

  if (estimate.tasksWithoutHistory.length > 0) {
    console.log(`  no history yet for: ${estimate.tasksWithoutHistory.join(", ")} (estimate above is partial)`);
  }
}

function usageTotalsToTokens(totals: {
  readonly inputUncachedTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
} | null): UsageCheckpointTokens {
  if (!totals) {
    return { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null };
  }

  return {
    inputUncachedTokens: totals.inputUncachedTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    outputTokens: totals.outputTokens,
    costUsd: totals.costUsd
  };
}

function sumTokensOrNull(tokens: UsageCheckpointTokens): number | null {
  const { inputUncachedTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = tokens;

  if (inputUncachedTokens === null && cacheReadTokens === null && cacheWriteTokens === null && outputTokens === null) {
    return null;
  }

  return (inputUncachedTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + (outputTokens ?? 0);
}

/** Best-effort cross-check against Codex CLI's own local rate-limit reading (the
 *  most recently modified rollout file at the time of the checkpoint - not
 *  necessarily produced by this exact run, since `codex exec` invocations across an
 *  entire ai-code-worker run share the same session-log directory tree). Claude has
 *  no equivalent local reading to cross-check against (see claude-calibration.ts). */
function codexSessionCrossCheck(engine: "fake" | "codex" | "claude"): {
  readonly contextEstimateTokens: number | null;
  readonly percentUsedReported: number | null;
} {
  if (engine !== "codex") {
    return { contextEstimateTokens: null, percentUsedReported: null };
  }

  const path = findLatestCodexRolloutPath();
  const summary = path ? readCodexSessionLog(path) : null;

  return {
    contextEstimateTokens: summary?.totalTokenUsage?.totalTokens ?? null,
    percentUsedReported: summary?.usedPercent ?? null
  };
}

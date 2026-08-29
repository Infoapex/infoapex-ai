#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClaudeAdapter } from './engine/claude-adapter.js';
import { decomposePrompt } from './decompose/decompose-prompt.js';
import { validateAgainstSchema } from './schema-validate.js';
import { lintPlan } from './linter/lint-plan.js';
import { projectToWorkerV1_1 } from './projection/project-to-worker-v1.js';
import { writePlanMarkdown } from './plan-file/write-plan-markdown.js';
import { readPlanMarkdown } from './plan-file/read-plan-markdown.js';
import type { Plan, Finding } from './types.js';
import { publishPlannerHandoff, readWorkerFeedback } from './integration/apex-integration.js';
import { collectPlannerContext } from './context/ai-code-control-cli.js';
import { applyRoutingProposal } from './routing/propose-routing.js';
import { validateWorkerTaskExportV1_1 } from './projection/validate-worker-export.js';
import { replanFromWorkerFeedback } from './replan/replan-from-worker.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'propose') {
  const prompt = args[1];
  const outPath = readOption('--out');
  const claudeExecutable = readOption('--claude-executable');
  const claudeModel = readOption('--claude-model');
  const claudeTimeoutMs = parseIntOption('--claude-timeout-ms');
  const controlExecutable = readOption('--control-executable');
  const repositoryPath = readOption('--repo') ?? process.cwd();
  const asJson = args.includes('--json');

  if (!prompt || prompt.startsWith('--')) {
    console.error('Usage: ai-code-planner propose <prompt> [--out <path>] [--repo <path>] [--no-context] [--control-executable <path>] [--claude-executable <path>] [--claude-model <model>] [--claude-timeout-ms <ms>]');
    process.exitCode = 1;
  } else {
    const adapter = createClaudeAdapter({
      ...(claudeExecutable !== null ? { executable: claudeExecutable } : {}),
      ...(claudeModel !== null ? { defaultModel: claudeModel } : {}),
      cwd: repositoryPath,
      ...(claudeTimeoutMs !== null ? { timeoutMs: claudeTimeoutMs } : {})
    });

    const context = args.includes('--no-context')
      ? undefined
      : collectPlannerContext({ repositoryPath, ...(controlExecutable !== null ? { executable: controlExecutable } : {}) });
    const result = decomposePrompt(adapter, prompt, { context, resolvedModel: claudeModel });

    if (!result.ok) {
      if (asJson) {
        console.log(JSON.stringify({ status: 'BLOCKED', error: result.error }));
        process.exitCode = 2;
      } else {
        console.error('ai-code-planner propose: BLOCKED');
        console.error(result.error);
        process.exitCode = 1;
      }
    } else {
      const draftPath = outPath ?? join('.ai-code-planner', 'drafts', `${slugify(prompt)}-${shortId()}.plan.json`);
      mkdirSync(dirname(draftPath), { recursive: true });
      writeFileSync(draftPath, JSON.stringify(result.plan, null, 2), 'utf-8');
      if (asJson) {
        console.log(JSON.stringify({ status: 'DONE', draftPath }));
      } else {
        console.log('ai-code-planner propose: DONE');
        console.log(`  draft: ${draftPath}`);
      }
      process.exitCode = 0;
    }
  }
} else if (command === 'inspect') {
  const draftPath = args[1];
  const asJson = args.includes('--json');

  if (!draftPath || draftPath.startsWith('--')) {
    console.error('Usage: ai-code-planner inspect <draft-path>');
    process.exitCode = 1;
  } else {
    let raw: unknown = null;
    let readError: string | null = null;

    try {
      raw = JSON.parse(readFileSync(draftPath, 'utf-8'));
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    if (readError !== null) {
      if (asJson) {
        console.log(JSON.stringify({ status: 'BLOCKED', error: readError }));
      } else {
        console.error('ai-code-planner inspect: BLOCKED');
        console.error(readError);
      }
      process.exitCode = 2;
    } else {
      const schemaResult = validateAgainstSchema<Plan>('plan.schema.json', raw);

      let lintOk = false;
      let findings: Finding[] = [];
      let schemaErrors: string[] = [];

      if (schemaResult.valid) {
        const lintResult = lintPlan(schemaResult.data);
        lintOk = lintResult.ok;
        findings = lintResult.findings;
      } else {
        schemaErrors = schemaResult.errors;
      }

      const schemaValid = schemaResult.valid;
      const report = { schemaValid, schemaErrors, lintOk, findings };

      if (asJson) {
        console.log(JSON.stringify(report));
      } else {
        console.log(`ai-code-planner inspect: ${schemaValid && lintOk ? 'PASS' : 'BLOCKED'}`);
        for (const e of schemaErrors) {
          console.log(`  SCHEMA: ${e}`);
        }
        for (const f of findings) {
          console.log(`  ${f.severity.toUpperCase()} ${f.id}: ${f.claim}`);
        }
      }

      process.exitCode = schemaValid && lintOk ? 0 : 2;
    }
  }
} else if (command === 'compile') {
  const draftPath = args[1];
  const taskId = readOption('--task-id');
  const outPath = readOption('--out');
  const asJson = args.includes('--json');
  const maximumParallelWriters = parseIntOption('--maximum-parallel-writers') ?? 1;
  const maximumRepairCycles = parseIntOption('--maximum-repair-cycles') ?? 2;
  const maximumTaskMinutes = parseIntOption('--maximum-task-minutes') ?? 20;
  const maximumRunMinutes = parseIntOption('--maximum-run-minutes') ?? 30;
  const repositoryPath = readOption('--repo') ?? process.cwd();

  if (!draftPath || draftPath.startsWith('--')) {
    console.error('Usage: ai-code-planner compile <draft-path> --task-id <id> [--out <Plan/path.md>]');
    process.exitCode = 1;
  } else if (!taskId) {
    console.error('Missing required option: --task-id <id>');
    process.exitCode = 1;
  } else {
    let raw: unknown = null;
    let readError: string | null = null;

    try {
      raw = JSON.parse(readFileSync(draftPath, 'utf-8'));
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    if (readError !== null) {
      if (asJson) {
        console.log(JSON.stringify({ status: 'BLOCKED', error: readError }));
      } else {
        console.error('ai-code-planner compile: BLOCKED');
        console.error(readError);
      }
      process.exitCode = 2;
    } else {
      const schemaResult = validateAgainstSchema<Plan>('plan.schema.json', raw);

      if (!schemaResult.valid) {
        if (asJson) {
          console.log(JSON.stringify({ status: 'BLOCKED', schemaErrors: schemaResult.errors }));
        } else {
          console.log('ai-code-planner compile: BLOCKED');
          for (const e of schemaResult.errors) {
            console.log(`  SCHEMA: ${e}`);
          }
        }
        process.exitCode = 2;
      } else {
        const lintResult = lintPlan(schemaResult.data);

        if (!lintResult.ok) {
          if (asJson) {
            console.log(JSON.stringify({ status: 'BLOCKED', findings: lintResult.findings }));
          } else {
            console.log('ai-code-planner compile: BLOCKED');
            for (const f of lintResult.findings) {
              console.log(`  ${f.severity.toUpperCase()} ${f.id}: ${f.claim}`);
            }
          }
          process.exitCode = 2;
        } else {
          const planned = applyRoutingProposal(schemaResult.data);
          const { manifestTasks, globalGates, projectionWarnings } = projectToWorkerV1_1(planned);
          const workerExportErrors = validateWorkerTaskExportV1_1(manifestTasks);

          if (workerExportErrors.length > 0) {
            if (asJson) {
              console.log(JSON.stringify({ status: 'BLOCKED', workerExportErrors }));
            } else {
              console.log('ai-code-planner compile: BLOCKED');
              for (const error of workerExportErrors) console.log(`  WORKER_EXPORT: ${error}`);
            }
            process.exitCode = 2;
          } else {

          const budgets = {
            maximumParallelWriters,
            maximumRepairCycles,
            maximumTaskMinutes,
            maximumRunMinutes,
            maximumAgentInvocations: 4,
            maximumRunInputUncachedTokens: 200_000,
            maximumRunCacheReadTokens: 200_000,
            maximumRunCacheWriteTokens: 200_000,
            maximumRunOutputTokens: 50_000,
            maximumRunCostUsd: 2.0,
            onUnknownUsage: 'warn'
          };

          const planPath = outPath ?? join('Plan', `${taskId}.md`);
          mkdirSync(dirname(planPath), { recursive: true });

          writePlanMarkdown({
            filePath: planPath,
            workerContractVersion: '1.1',
            goal: planned.goal,
            tasks: manifestTasks,
            globalGates,
            budgets
          });

          const handoffRunId = `${taskId}-${shortId()}`;
          const handoffPath = publishPlannerHandoff({
            repositoryPath,
            planPath,
            runId: handoffRunId,
            goal: planned.goal,
            tasks: planned.tasks
          });

          if (asJson) {
            console.log(JSON.stringify({ status: 'DONE', planPath, projectionWarnings, ...(handoffPath ? { handoffPath, handoffRunId } : {}) }));
          } else {
            console.log('ai-code-planner compile: DONE');
            console.log(`  plan: ${planPath}`);
            for (const w of projectionWarnings) {
              console.log(`  WARNING task ${w.taskId}: lost fields: ${w.lostFields.join(', ')}`);
            }
            if (handoffPath) console.log(`  handoff: ${handoffPath}`);
          }
          process.exitCode = 0;
          }
        }
      }
    }
  }
} else if (command === 'explain-routing') {
  const inputPath = args[1];

  if (!inputPath || inputPath.startsWith('--')) {
    console.error('Usage: ai-code-planner explain-routing <draft-path-or-Plan-md-path>');
    process.exitCode = 1;
  } else {
    let tasks: Array<{ id: string; executionProfile?: string }> = [];
    let resolveError: string | null = null;

    try {
      const content = readFileSync(inputPath, 'utf-8');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(content);
      } catch {
        // not JSON - fall through to readPlanMarkdown
      }

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'tasks' in (parsed as Record<string, unknown>)
      ) {
        const plan = parsed as Plan;
        tasks = plan.tasks.map(t => ({ id: t.id, executionProfile: t.executionProfile }));
      } else {
        const planData = readPlanMarkdown(inputPath);
        tasks = planData.tasks.map(t => ({
          id: t.id,
          executionProfile: (t as unknown as { executionProfile?: string }).executionProfile
        }));
      }
    } catch (err) {
      resolveError = err instanceof Error ? err.message : String(err);
    }

    if (resolveError !== null) {
      console.error('ai-code-planner explain-routing: BLOCKED');
      console.error(resolveError);
      process.exitCode = 2;
    } else {
      const UNRESOLVED_NOTE = 'declared, not resolved by planner -- worker resolves the concrete engine/model at compile time';
      for (const t of tasks) {
        if (t.executionProfile !== undefined) {
          console.log(`${t.id}: executionProfile=${t.executionProfile} (${UNRESOLVED_NOTE})`);
        } else {
          console.log(`${t.id}: no executionProfile declared`);
        }
      }
      process.exitCode = 0;
    }
  }
} else if (command === 'ingest-worker-report') {
  const runId = args[1];
  const repositoryPath = readOption('--repo') ?? process.cwd();
  const asJson = args.includes('--json');
  if (!runId || runId.startsWith('--')) {
    console.error('Usage: ai-code-planner ingest-worker-report <run-id> [--repo <path>] [--json]');
    process.exitCode = 1;
  } else {
    try {
      const feedback = readWorkerFeedback(repositoryPath, runId) as { payload?: { status?: string; findings?: unknown[] } };
      const status = feedback.payload?.status ?? 'UNKNOWN';
      const continuationRequired = status !== 'DONE';
      const report = { status: 'DONE', runId, workerStatus: status, continuationRequired, findings: feedback.payload?.findings ?? [] };
      if (asJson) console.log(JSON.stringify(report, null, 2));
      else console.log(`ai-code-planner ingest-worker-report: ${status} (${continuationRequired ? 'continuation required' : 'complete'})`);
      process.exitCode = continuationRequired ? 2 : 0;
    } catch (error) {
      console.error(`ai-code-planner ingest-worker-report: BLOCKED`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
} else if (command === 'replan') {
  const draftPath = args[1];
  const runId = args[2];
  const outPath = readOption('--out');
  const repositoryPath = readOption('--repo') ?? process.cwd();
  const profile = readOption('--profile') ?? 'balanced-default-v1';
  const taskIds = (readOption('--task-ids') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const asJson = args.includes('--json');

  if (!draftPath || !runId || draftPath.startsWith('--') || runId.startsWith('--')) {
    console.error('Usage: ai-code-planner replan <draft-path> <run-id> [--out <path>] [--repo <path>] [--profile <logical-profile>] [--task-ids A,B]');
    process.exitCode = 1;
  } else {
    try {
      const raw = JSON.parse(readFileSync(draftPath, 'utf-8')) as unknown;
      const schemaResult = validateAgainstSchema<Plan>('plan.schema.json', raw);
      if (!schemaResult.valid) throw new Error(`Draft plan is invalid: ${schemaResult.errors.join('; ')}`);
      const feedback = readWorkerFeedback(repositoryPath, runId);
      const result = replanFromWorkerFeedback(schemaResult.data, feedback, { profile, taskIds });
      const nextPlan = result.affectedTaskIds.length > 0 ? applyRoutingProposal(result.plan) : result.plan;
      const targetPath = outPath ?? `${draftPath.replace(/\.json$/i, '')}.replan.json`;
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify(nextPlan, null, 2)}\n`, 'utf-8');
      const report = { status: result.affectedTaskIds.length > 0 ? 'DONE' : 'NO_ACTION', targetPath, affectedTaskIds: result.affectedTaskIds, reason: result.reason };
      if (asJson) console.log(JSON.stringify(report));
      else console.log(`ai-code-planner replan: ${report.status} (${result.reason})\n  draft: ${targetPath}`);
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (asJson) console.log(JSON.stringify({ status: 'BLOCKED', error: message }));
      else console.error(`ai-code-planner replan: BLOCKED\n${message}`);
      process.exitCode = 2;
    }
  }
} else {
  console.error('Usage: ai-code-planner <propose|inspect|compile|explain-routing|ingest-worker-report|replan>');
  process.exitCode = 1;
}

function readOption(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function parseIntOption(name: string): number | null {
  const value = readOption(name);
  if (value === null) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function shortId(): string {
  return randomBytes(4).toString('hex');
}

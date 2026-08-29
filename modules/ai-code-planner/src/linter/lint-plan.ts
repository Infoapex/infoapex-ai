import type { Plan, PlanTask, Finding } from '../types.js';

let _counter = 0;

function makeId(): string {
  return `LINT-${String(++_counter).padStart(4, '0')}`;
}

function blocker(type: Finding['type'], claim: string): Finding {
  return { id: makeId(), type, severity: 'blocker', claim, status: 'proposed' };
}

function detectCycles(tasks: PlanTask[]): string[][] {
  const taskSet = new Set(tasks.map(t => t.id));
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.id, t.dependsOn.filter(d => taskSet.has(d)));
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(tasks.map(t => [t.id, WHITE]));
  const cycles: string[][] = [];
  const seen = new Set<string>();

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const nb of adj.get(node) ?? []) {
      if (color.get(nb) === GRAY) {
        const start = path.indexOf(nb);
        const cycle = [...path.slice(start), nb];
        const key = [...cycle].sort().join('\0');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(nb) === WHITE) {
        dfs(nb, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const t of tasks) {
    if (color.get(t.id) === WHITE) dfs(t.id, []);
  }
  return cycles;
}

// Wave = longest path from a root. Tasks in the same wave have no ordering relationship.
function computeWaves(tasks: PlanTask[]): Map<string, number> {
  const taskSet = new Set(tasks.map(t => t.id));
  const memo = new Map<string, number>();

  function wave(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    const task = tasks.find(t => t.id === id);
    if (!task) { memo.set(id, 0); return 0; }
    const deps = task.dependsOn.filter(d => taskSet.has(d));
    const w = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(wave));
    memo.set(id, w);
    return w;
  }

  for (const t of tasks) wave(t.id);
  return memo;
}

export function lintPlan(plan: Plan): { ok: boolean; findings: Finding[] } {
  _counter = 0;
  const findings: Finding[] = [];
  const tasks = plan.tasks;
  const taskSet = new Set(tasks.map(t => t.id));

  // 1. DAG_ACYCLIC
  const cycles = detectCycles(tasks);
  for (const cycle of cycles) {
    findings.push(blocker('internal-contradiction',
      `CYCLIC_DEPENDENCY: task ${cycle[0]} participates in a dependency cycle: ${cycle.join(' → ')}`));
  }

  // 2. DEPENDENCY_EXISTS
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskSet.has(dep)) {
        findings.push(blocker('internal-contradiction',
          `UNKNOWN_DEPENDENCY: task ${task.id} dependsOn '${dep}' which does not exist in this plan`));
      }
    }
  }

  // 3. REQUIRED_INPUTS_TYPED
  for (const task of tasks) {
    const inputs = task.requiredInputs;
    for (let n = 0; n < inputs.length; n++) {
      const inp = inputs[n] as unknown as Record<string, unknown>;
      if (!inp['kind'] || !inp['ref'] || typeof inp['ref'] !== 'string' || inp['ref'].length === 0) {
        findings.push(blocker('omission',
          `UNTYPED_INPUT: task ${task.id} requiredInputs[${n}] is missing 'kind' or 'ref'`));
      }
    }
  }

  // 4. SCOPE_NO_UNCONTROLLED_OVERLAP (skip when cycles exist — wave numbers are undefined)
  if (cycles.length === 0) {
    const waveOf = computeWaves(tasks);
    const byWave = new Map<number, PlanTask[]>();
    for (const task of tasks) {
      const w = waveOf.get(task.id) ?? 0;
      if (!byWave.has(w)) byWave.set(w, []);
      byWave.get(w)!.push(task);
    }
    for (const waveTasks of byWave.values()) {
      for (let i = 0; i < waveTasks.length; i++) {
        for (let j = i + 1; j < waveTasks.length; j++) {
          const a = waveTasks[i];
          const b = waveTasks[j];
          const aSet = new Set(a.scope.allowedPaths);
          const overlap = b.scope.allowedPaths.filter(p => aSet.has(p));
          if (overlap.length > 0) {
            findings.push(blocker('internal-contradiction',
              `SCOPE_OVERLAP: tasks ${a.id} and ${b.id} run in the same wave and share allowedPaths entries: ${overlap.join(', ')}`));
          }
        }
      }
    }
  }

  // 5. SCOPE_NO_SELF_INTERSECTION
  for (const task of tasks) {
    const allowed = new Set(task.scope.allowedPaths);
    for (const p of task.scope.forbiddenPaths) {
      if (allowed.has(p)) {
        findings.push(blocker('internal-contradiction',
          `SCOPE_SELF_INTERSECTION: task ${task.id} lists '${p}' in both allowedPaths and forbiddenPaths`));
      }
    }
  }

  // 6. HIGH_RISK_REQUIRES_GATES
  for (const task of tasks) {
    if (task.risk === 'high' && task.gates.length === 0) {
      findings.push(blocker('omission',
        `HIGH_RISK_NO_GATES: task ${task.id} has risk 'high' but gates is empty`));
    }
  }

  // 7. GATE_CRITERION_REF
  const planCriterionIds = new Set<string>();
  const planGateIds = new Set<string>();
  for (const task of tasks) {
    const criteria = task.acceptanceCriteria;
    const gates = task.gates;
    const criterionIds = new Set(criteria.map(c => c.criterionId));
    const coveredCriterionIds = new Set<string>();

    // (a) unique criterionIds
    const seenCriteria = new Set<string>();
    for (const c of criteria) {
      if (seenCriteria.has(c.criterionId)) {
        findings.push(blocker('internal-contradiction',
          `DUPLICATE_CRITERION_ID: task ${task.id} has duplicate criterionId '${c.criterionId}' in acceptanceCriteria`));
      }
      seenCriteria.add(c.criterionId);
      if (planCriterionIds.has(c.criterionId)) {
        findings.push(blocker('internal-contradiction',
          `DUPLICATE_CRITERION_ID: criterionId '${c.criterionId}' is duplicated across the plan`));
      }
      planCriterionIds.add(c.criterionId);
    }

    for (const gate of gates) {
      if (planGateIds.has(gate.gateId)) {
        findings.push(blocker('internal-contradiction',
          `DUPLICATE_GATE_ID: gateId '${gate.gateId}' is duplicated across the plan`));
      }
      planGateIds.add(gate.gateId);
      for (const criterionId of gate.criterionIds) {
        if (!criterionIds.has(criterionId)) {
          findings.push(blocker('internal-contradiction',
            `UNKNOWN_CRITERION: task ${task.id} gate '${gate.gateId}' references criterionId '${criterionId}' which does not exist on this task`));
        } else {
          coveredCriterionIds.add(criterionId);
        }
      }
    }
    for (const criterionId of criterionIds) {
      if (!coveredCriterionIds.has(criterionId)) {
        findings.push(blocker('omission',
          `UNCOVERED_CRITERION: task ${task.id} criterion '${criterionId}' is not covered by any gate`));
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

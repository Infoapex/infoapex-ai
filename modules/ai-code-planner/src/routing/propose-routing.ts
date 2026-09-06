import type { Plan, PlanTask } from '../types.js';

export const ROUTING_POLICY_VERSION = 'planner-logical-v2';

export function applyRoutingProposal(plan: Plan): Plan {
  const routingProposal = plan.tasks.map(task => {
    const profile = task.executionProfile ?? chooseProfile(task);
    return {
      taskId: task.id,
      profile,
      reason: profile === 'mechanical-fast-v1'
        ? 'Low-risk mechanical, test, fixture, or documentation work.'
        : 'Use the balanced profile for implementation, contracts, integrations, and higher-risk changes.',
      confidence: task.executionProfile ? 'high' : 'medium'
    };
  });
  return {
    ...plan,
    tasks: plan.tasks.map(task => ({ ...task, executionProfile: task.executionProfile ?? routingProposal.find(item => item.taskId === task.id)!.profile })),
    planningProvenance: {
      ...(plan.planningProvenance ?? {}),
      routingPolicyVersion: ROUTING_POLICY_VERSION,
      routingProposal
    }
  };
}

function chooseProfile(task: PlanTask): 'mechanical-fast-v1' | 'balanced-default-v1' {
  const text = `${task.goal} ${task.acceptanceCriteria.map(item => item.text).join(' ')}`.toLowerCase();
  const goal = task.goal.toLowerCase();
  const mechanical = /documentation|docs?|readme|fixture|format|rename|typo|lint|test(?:s|ing)?|snapshot|lockfile/.test(text);
  // A high-risk task often contains tests and fixtures in its acceptance criteria.
  // Test vocabulary must never downgrade an explicit risk classification.
  if (task.risk === 'high') return 'balanced-default-v1';
  // A test-only task can mention a sensitive subject (for example, an API
  // contract) without modifying it. The explicit risk field remains the
  // authority whenever that test task actually changes a high-risk surface.
  const testOnlyGoal = /^(add|write|update|fix|extend)\s+(unit\s+|integration\s+|e2e\s+)?tests?\b/.test(goal);
  if (testOnlyGoal) return 'mechanical-fast-v1';
  const highRisk = /migration|database|schema|contract|security|auth|payment|concurrency|production/.test(text);
  return mechanical && !highRisk ? 'mechanical-fast-v1' : 'balanced-default-v1';
}

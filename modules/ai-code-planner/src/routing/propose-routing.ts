import type { Plan, PlanTask } from '../types.js';

export const ROUTING_POLICY_VERSION = 'planner-logical-v1';

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
  const mechanical = /documentation|docs?|readme|fixture|format|rename|typo|lint|test(?:s|ing)?|snapshot|lockfile/.test(text);
  const testLike = /test(?:s|ing)?|fixture|coverage/.test(text);
  const highRisk = !testLike && (task.risk === 'high' || /migration|database|schema|contract|security|auth|payment|concurrency|production/.test(text));
  return mechanical && !highRisk ? 'mechanical-fast-v1' : 'balanced-default-v1';
}

export type PlannerContextStatus = 'OK' | 'UNAVAILABLE' | 'ERROR' | 'DISABLED';

export interface PlannerContext {
  readonly status: PlannerContextStatus;
  readonly provider: 'ai-code-control' | 'none';
  readonly health?: string;
  readonly brief?: string;
  readonly relevantFiles?: readonly string[];
  readonly symbolMatches?: readonly { symbol: string; file: string; line: number | null }[];
  readonly impacts?: readonly { symbol: string; affectedFiles: readonly string[]; riskNotes: readonly string[] }[];
  readonly warnings?: readonly string[];
}

export function contextForPrompt(context: PlannerContext | undefined): string {
  if (!context || context.status === 'DISABLED') return 'Context provider: disabled.';
  const lines = [`Context provider: ${context.provider} (${context.status}).`];
  if (context.health) lines.push(`Health: ${context.health}`);
  if (context.brief) lines.push(`Project brief:\n${context.brief}`);
  if (context.relevantFiles?.length) lines.push(`Relevant files: ${context.relevantFiles.join(', ')}`);
  if (context.symbolMatches?.length) {
    lines.push(`Symbol matches:\n${context.symbolMatches.map(match => `- ${match.symbol} at ${match.file}${match.line ? `:${match.line}` : ''}`).join('\n')}`);
  }
  if (context.impacts?.length) {
    lines.push(`Symbol impacts:\n${context.impacts.map(impact => `- ${impact.symbol}: ${impact.affectedFiles.join(', ') || 'no indexed files'}${impact.riskNotes.length ? ` (${impact.riskNotes.join('; ')})` : ''}`).join('\n')}`);
  }
  if (context.warnings?.length) lines.push(`Context warnings: ${context.warnings.join('; ')}`);
  return lines.join('\n');
}

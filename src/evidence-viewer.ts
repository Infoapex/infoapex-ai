import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_RUNS = 128;
const MAX_TASKS = 256;

export interface EvidenceViewResult {
  readonly status: "PASS" | "BLOCKED";
  readonly code?: string;
  readonly message?: string;
  readonly runCount?: number;
  readonly runIds?: readonly string[];
  readonly html?: string;
}

interface RunSummary {
  readonly runId: string;
  readonly provider: string;
  readonly status: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly manifestSha256: string | null;
  readonly taskCount: number;
  readonly tasks: readonly { readonly id: string; readonly status: string; readonly gate: string; readonly commit: string }[];
  readonly eventCount: number | null;
  readonly lastEvent: { readonly type: string; readonly createdAt: string } | null;
  readonly recovery: { readonly code: string; readonly resumable: boolean | null } | null;
  readonly invalidEvidence: readonly string[];
}

/** Build a dependency-free, static, read-only view of bounded local run evidence.
 * Raw event payloads, process output, and recovery messages are intentionally not
 * rendered: the UI is a navigation aid, not a transcript or support bundle. */
export function buildEvidenceView(repositoryRoot: string, selectedRunId?: string | null): EvidenceViewResult {
  const repo = resolve(repositoryRoot);
  if (selectedRunId && !RUN_ID.test(selectedRunId)) return blocked("RUN_ID_INVALID", "Run id contains unsupported characters or is too long.");
  const runsRoot = join(repo, ".infoapex-ai", "runs");
  if (!existsSync(runsRoot)) return htmlResult(repo, []);
  const runIds = selectedRunId
    ? [selectedRunId]
    : readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name)).map((entry) => entry.name).sort().slice(0, MAX_RUNS);
  const summaries = runIds.map((runId) => summarizeRun(repo, runId));
  return htmlResult(repo, summaries);
}

function summarizeRun(repo: string, runId: string): RunSummary {
  const runRoot = join(repo, ".infoapex-ai", "runs", runId);
  const invalidEvidence: string[] = [];
  const state = readObject(join(runRoot, "state.json"), invalidEvidence, "state");
  const manifest = readObject(join(runRoot, "manifest.json"), invalidEvidence, "manifest");
  const events = readObject(join(runRoot, "events.json"), invalidEvidence, "events");
  const recovery = readObject(join(runRoot, "recovery-evidence.json"), invalidEvidence, "recovery");
  const tasks = state && state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) ? Object.entries(state.tasks).slice(0, MAX_TASKS).map(([id, value]) => {
    const task = object(value);
    return { id: bounded(id, 128), status: boundedString(task?.status), gate: boundedString(task?.gate), commit: boundedString(task?.commit) };
  }) : [];
  const eventList = events && Array.isArray(events.events) ? events.events : null;
  const last = eventList && eventList.length > 0 ? object(eventList[eventList.length - 1]) : null;
  const recoveryObject = object(recovery);
  return {
    runId,
    provider: boundedString(state?.provider),
    status: boundedString(state?.status),
    createdAt: nullableString(state?.createdAt),
    updatedAt: nullableString(state?.updatedAt),
    manifestSha256: nullableString(manifest?.manifestSha256) ?? nullableString(state?.manifestSha256),
    taskCount: state && state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) ? Object.keys(state.tasks).length : 0,
    tasks,
    eventCount: eventList ? eventList.length : null,
    lastEvent: last ? { type: boundedString(last.type), createdAt: boundedString(last.createdAt) } : null,
    recovery: recoveryObject ? { code: boundedString(recoveryObject.code), resumable: typeof recoveryObject.resumable === "boolean" ? recoveryObject.resumable : null } : null,
    invalidEvidence
  };
}

function htmlResult(repo: string, runs: readonly RunSummary[]): EvidenceViewResult {
  return { status: "PASS", runCount: runs.length, runIds: runs.map((run) => run.runId), html: renderHtml(runs) };
}

function renderHtml(runs: readonly RunSummary[]): string {
  const cards = runs.map((run) => {
    const tasks = run.tasks.length === 0 ? "<p class=muted>No task records.</p>" : `<table><thead><tr><th>Task</th><th>Status</th><th>Gate</th><th>Commit</th></tr></thead><tbody>${run.tasks.map((task) => `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.gate)}</td><td class=mono>${escapeHtml(task.commit)}</td></tr>`).join("")}</tbody></table>`;
    const evidenceWarning = run.invalidEvidence.length === 0 ? "" : `<p class=warning>Evidence warnings: ${run.invalidEvidence.map(escapeHtml).join(", ")}</p>`;
    return `<article><h2>${escapeHtml(run.runId)}</h2><dl><dt>Provider</dt><dd>${escapeHtml(run.provider)}</dd><dt>Status</dt><dd>${escapeHtml(run.status)}</dd><dt>Created</dt><dd>${escapeHtml(run.createdAt ?? "unknown")}</dd><dt>Updated</dt><dd>${escapeHtml(run.updatedAt ?? "unknown")}</dd><dt>Manifest</dt><dd class=mono>${escapeHtml(run.manifestSha256 ?? "unknown")}</dd><dt>Tasks</dt><dd>${run.taskCount}</dd><dt>Events</dt><dd>${run.eventCount === null ? "unavailable" : run.eventCount}</dd></dl>${run.lastEvent ? `<p class=muted>Last event: ${escapeHtml(run.lastEvent.type)} at ${escapeHtml(run.lastEvent.createdAt)}</p>` : ""}${run.recovery ? `<p class=warning>Recovery evidence: ${escapeHtml(run.recovery.code)}${run.recovery.resumable === null ? "" : run.recovery.resumable ? " (resumable)" : " (not resumable)"}</p>` : ""}${evidenceWarning}<h3>Tasks</h3>${tasks}</article>`;
  }).join("");
  const empty = runs.length === 0 ? "<p class=muted>No bounded run evidence was found.</p>" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>infoapex-ai evidence</title><style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172033;background:#f7f8fb}h1{margin-bottom:.25rem}article{background:#fff;border:1px solid #d8dce6;border-radius:10px;padding:1rem;margin:1rem 0;box-shadow:0 2px 8px #17203312}dl{display:grid;grid-template-columns:9rem 1fr;gap:.35rem;margin:1rem 0}dt{font-weight:600;color:#4b5565}dd{margin:0}.mono{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.muted{color:#667085}.warning{color:#9a3412;background:#fff7ed;border-left:3px solid #f97316;padding:.5rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-top:1px solid #e5e7eb;padding:.45rem}th{color:#4b5565}</style></head><body><h1>infoapex-ai local evidence</h1><p class=muted>Read-only local summary. Raw payloads and process output are omitted.</p>${empty}${cards}</body></html>`;
}

function readObject(path: string, invalidEvidence: string[], label: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = object(value);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    invalidEvidence.push(`${label}:invalid`);
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function boundedString(value: unknown): string { return typeof value === "string" ? bounded(value, 256) : "unknown"; }
function nullableString(value: unknown): string | null { return typeof value === "string" ? bounded(value, 256) : null; }
function bounded(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`; }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function blocked(code: string, message: string): EvidenceViewResult { return { status: "BLOCKED", code, message }; }

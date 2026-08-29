import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlRoot = join(root, "modules", "ai-code-control");
const controlSolution = join(controlRoot, "tools", "ai-code-control", "AiCodeControl.sln");
const controlDll = join(controlRoot, "tools", "ai-code-control", "src", "AiCodeControl.Cli", "bin", "Debug", "net9.0", "AiCodeControl.Cli.dll");
const valueGate = join(root, "scripts", "value-gate.mjs");
const timeoutMs = Number(process.env.APEX_COMMON_PILOT_TIMEOUT_MS ?? 180000);

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  return { status: result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runJson(command, args, cwd = root) {
  const result = run(command, args, cwd);
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* bounded report below */ }
  return { ...result, body };
}

function control(repository, ...args) {
  return runJson("dotnet", [controlDll, ...args, "--repo", repository], repository);
}

function write(repository, relative, value) {
  const path = join(repository, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nodeRef(nodeType, canonicalRef) { return { nodeType, canonicalRef }; }
function endpoint(type, canonicalRef) { return { type, canonicalRef }; }

function createFixture() {
  const repository = mkdtempSync(join(tmpdir(), "infoapex-common-pilot-"));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pilot@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Infoapex Common Pilot"], { cwd: repository });
  const initialized = control(repository, "init", "--template", "generic");
  if (initialized.status !== 0) throw new Error(`control init failed: ${initialized.stderr || initialized.stdout}`);

  const tasks = [];
  const sourceMapNodes = [];
  const sourceMapEdges = [];
  const documents = [];
  const requiredSources = [];
  const expectedNodes = [];
  const expectedEdges = [];

  for (let index = 1; index <= 5; index++) {
    const suffix = String(index).padStart(2, "0");
    const oldAdr = `ADR-01${suffix}`;
    const currentAdr = `ADR-02${suffix}`;
    write(repository, `docs/${oldAdr}.md`, `# ${oldAdr}\n\n**Status:** Accepted\n`);
    write(repository, `docs/${currentAdr}.md`, `# ${currentAdr}\n\n**Status:** Accepted\n\nSupersedes: ${oldAdr}\n`);
    documents.push(
      { kind: "adr", path: `docs/${oldAdr}.md`, canonicalRef: `docs/${oldAdr}.md` },
      { kind: "adr", path: `docs/${currentAdr}.md`, canonicalRef: `docs/${currentAdr}.md` }
    );
    requiredSources.push({ nodeType: "adr", canonicalRef: currentAdr, required: true });
    expectedNodes.push(nodeRef("adr", oldAdr), nodeRef("adr", currentAdr));
    expectedEdges.push({ from: nodeRef("adr", currentAdr), relation: "supersedes", to: nodeRef("adr", oldAdr), evidenceRef: `docs/${currentAdr}.md`, trustTier: "T1" });

    const contract = `contracts/pilot-${index}.schema.json`;
    write(repository, contract, { $schema: "https://json-schema.org/draft/2020-12/schema", $id: contract, title: `Pilot contract ${index}`, type: "object" });
    documents.push({ kind: "contract", path: contract, canonicalRef: contract });
    requiredSources.push({ nodeType: "contract", canonicalRef: contract, required: true });

    write(repository, `src/pilot-${index}.ts`, `export function pilotTarget${index}(): number { return ${index}; }\nexport function pilotCaller${index}(): number { return pilotTarget${index}(); }\n`);
    write(repository, `.ai-code-control/memory/tasks/pilot-query-${index}.md`, `# Pilot memory ${index}\n\nUnique memory route phrase ALPHA-PILOT-${index}.\n`);
  }

  for (let index = 1; index <= 10; index++) {
    const suffix = String(index).padStart(2, "0");
    const task = `PILOT-TASK-${suffix}`;
    const criterion = `PILOT-AC-${suffix}`;
    const gate = `PILOT-GATE-${suffix}`;
    const evidence = `pilot/evidence-${suffix}.json`;
    const contract = `contracts/pilot-${((index - 1) % 5) + 1}.schema.json`;
    const file = `src/pilot-${((index - 1) % 5) + 1}.ts`;
    tasks.push({ id: task, goal: `Validate common ICM and Graph pilot task ${suffix}`,
      acceptanceCriteria: [{ criterionId: criterion, text: `Pilot criterion ${suffix} is evidenced.` }],
      gates: [{ gateId: gate, command: "node scripts/pass-gate.mjs", evidenceContract: "exit 0", criterionIds: [criterion] }],
      dependsOn: [],
      requiredInputs: [{ kind: "contract", ref: contract }] });
    sourceMapNodes.push(
      { nodeId: `task-${suffix}`, kind: "task", canonicalRef: task, authority: "canonical" },
      { nodeId: `gate-${suffix}`, kind: "gate", canonicalRef: gate, authority: "canonical" },
      { nodeId: `evidence-${suffix}`, kind: "evidence", canonicalRef: evidence, authority: "canonical" },
      { nodeId: `file-${suffix}`, kind: "file", canonicalRef: file, authority: "canonical" }
    );
    sourceMapEdges.push(
      { fromNodeId: `gate-${suffix}`, toNodeId: `evidence-${suffix}`, relation: "verified_by", confidence: "observed", evidenceRefs: [evidence] },
      { fromNodeId: `file-${suffix}`, toNodeId: `task-${suffix}`, relation: "changed_by", confidence: "observed", evidenceRefs: [evidence] }
    );
    for (const [nodeType, canonicalRef] of [["task", task], ["criterion", criterion], ["gate", gate], ["evidence", evidence]]) {
      requiredSources.push({ nodeType, canonicalRef, required: true });
      expectedNodes.push(nodeRef(nodeType, canonicalRef));
    }
    expectedEdges.push(
      { from: nodeRef("task", task), relation: "implements", to: nodeRef("criterion", criterion), evidenceRef: "fixtures/pilot-plan.json", trustTier: "T1" },
      { from: nodeRef("criterion", criterion), relation: "verified_by", to: nodeRef("gate", gate), evidenceRef: "fixtures/pilot-plan.json", trustTier: "T1" },
      { from: nodeRef("gate", gate), relation: "verified_by", to: nodeRef("evidence", evidence), evidenceRef: `fixtures/pilot-source-map.json::${evidence}`, trustTier: "T0" }
    );
  }

  write(repository, "scripts/pass-gate.mjs", "process.exit(0);\n");
  write(repository, "fixtures/pilot-plan.json", { goal: "Common ICM and Graph pilot", tasks });
  write(repository, "fixtures/pilot-source-map.json", {
    schemaVersion: "1.0", runId: "COMMON-PILOT", sourceMapDigest: "b".repeat(64),
    nodes: sourceMapNodes, edges: sourceMapEdges,
    coverage: { totalRelations: sourceMapEdges.length, tracedRelations: sourceMapEdges.length, traceCoveragePercent: 100, complete: true }
  });
  documents.push(
    { kind: "plan", path: "fixtures/pilot-plan.json", canonicalRef: "fixtures/pilot-plan.json" },
    { kind: "source-map", path: "fixtures/pilot-source-map.json", canonicalRef: "fixtures/pilot-source-map.json" }
  );
  write(repository, "fixtures/trace-ingest.json", { schemaVersion: "1.0", includeCodeIndex: true, documents });
  write(repository, "fixtures/trace-sources.json", { schemaVersion: "1.0", sources: requiredSources });
  write(repository, "fixtures/expected-graph.json", { schemaVersion: "1.0", mode: "subset", nodes: expectedNodes, edges: expectedEdges });

  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "common pilot fixture"], { cwd: repository, stdio: "ignore" });
  return repository;
}

function main() {
  const build = run("dotnet", ["build", controlSolution, "--nologo"]);
  if (build.status !== 0) throw new Error(`control build failed: ${build.stderr || build.stdout}`);
  const icm = runJson(process.execPath, [valueGate], root);
  if (icm.status !== 0 || icm.body?.status !== "PASS") {
    console.log(JSON.stringify({ status: "BLOCKED", releaseDecision: "ICM_GATE_FAILED", icm: icm.body, stderr: icm.stderr.slice(-3000) }, null, 2));
    process.exitCode = 2;
    return;
  }

  const repository = createFixture();
  const queryResults = [];
  try {
    const indexed = control(repository, "index-code", "--path", ".", "--full");
    const memory = control(repository, "memory-ingest");
    const ingested = control(repository, "trace-ingest", "--manifest", "fixtures/trace-ingest.json");
    if ([indexed, memory, ingested].some(result => result.status !== 0 || !["ok", "OK"].includes(result.body?.status)))
      throw new Error(`fixture preparation failed: ${JSON.stringify({ indexed: indexed.body, memory: memory.body, ingested: ingested.body })}`);

    for (let index = 1; index <= 5; index++) {
      const suffix = String(index).padStart(2, "0");
      const current = control(repository, "current", `ADR-01${suffix}`, "--depth", "3");
      queryResults.push({ id: `temporal-${index}`, route: "trace/current", passed: current.status === 0 && current.body?.status === "ok" && current.body?.currentEntities?.some(node => node.canonicalRef === `ADR-02${suffix}`) });
      const evidence = control(repository, "evidence-for", `PILOT-TASK-${suffix}`, "--depth", "5");
      queryResults.push({ id: `evidence-${index}`, route: "trace/evidence-for", passed: evidence.status === 0 && evidence.body?.status === "ok" && evidence.body?.evidenceComplete === true && evidence.body?.nodes?.some(node => node.nodeType === "evidence") });
      const affected = control(repository, "affected", `contracts/pilot-${index}.schema.json`, "--depth", "5");
      queryResults.push({ id: `affected-${index}`, route: "trace/affected", passed: affected.status === 0 && affected.body?.status === "ok" && affected.body?.nodes?.some(node => node.nodeType === "file") && affected.body?.nodes?.some(node => node.nodeType === "evidence") });
      const impact = control(repository, "impact-analysis", `pilotTarget${index}`, "--depth", "3");
      queryResults.push({ id: `blast-${index}`, route: "code/impact-analysis", passed: impact.status === 0 && impact.body?.status === "ok" && Number(impact.body?.affectedSymbols ?? 0) >= 1 });
      const fts = control(repository, "memory-search", `ALPHA-PILOT-${index}`, "--limit", "5");
      queryResults.push({ id: `fts-${index}`, route: "memory/fts", passed: fts.status === 0 && (fts.body?.matches?.length ?? 0) >= 1 });
    }

    const exported = control(repository, "obsidian-export", "--path", ".", "--out", "docs/code-map/generated");
    const drift = control(repository, "graph-drift", "--scope", ".", "--sources", "fixtures/trace-sources.json",
      "--expected-graph", "fixtures/expected-graph.json", "--projection-manifest", "docs/code-map/generated/.trace-projection-manifest.json", "--minimum-coverage", "100", "--fail-on-review");
    const passedQueries = queryResults.filter(result => result.passed).length;
    const graphPass = passedQueries === 25 && exported.status === 0 && drift.status === 0 && drift.body?.status === "PASS";
    const report = {
      schemaVersion: "1.0",
      status: graphPass ? "PASS" : "BLOCKED",
      mode: "internal",
      usageConsuming: false,
      releaseDecision: graphPass ? "INTERNAL_PASS_LIVE_REQUIRED" : "BLOCKED",
      icm: { releaseDecision: icm.body.releaseDecision, metrics: icm.body.metrics },
      graph: {
        metrics: {
          queryFixturesPassed: passedQueries,
          queryFixturesTotal: 25,
          temporalChains: 5,
          traceablePilotTasks: 10,
          contractCodeEvidenceQueries: queryResults.filter(item => item.route === "trace/affected" && item.passed).length,
          codeBlastRadiusQueries: queryResults.filter(item => item.route === "code/impact-analysis" && item.passed).length,
          ftsQueries: queryResults.filter(item => item.route === "memory/fts" && item.passed).length,
          graphDriftStatus: drift.body?.status ?? "error",
          evidenceCoveragePercent: drift.body?.coverage?.coveragePercent ?? null,
          projectionStatus: drift.body?.projection?.status ?? "error"
        },
        ingest: {
          status: ingested.body?.status,
          documentsRead: ingested.body?.DocumentsRead,
          documentsSkipped: ingested.body?.DocumentsSkipped,
          nodesProduced: ingested.body?.NodesProduced,
          edgesProduced: ingested.body?.EdgesProduced,
          diagnosticCounts: Object.fromEntries(["error", "warning", "info"].map(severity => [severity,
            (ingested.body?.diagnostics ?? []).filter(item => String(item?.Severity).toLowerCase() === severity).length]))
        },
        queryFailures: queryResults.filter(result => !result.passed),
        driftFindings: drift.body?.findings ?? [],
        exportStatus: exported.body?.Status ?? exported.body?.status ?? "error"
      },
      recommendation: graphPass
        ? "Run the bounded usage-consuming 10-task live pilot before release; keep GRAPH-06 disabled."
        : "Repair deterministic pilot failures before any live or parallel-provider experiment."
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = graphPass ? 0 : 2;
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  console.log(JSON.stringify({ status: "BLOCKED", releaseDecision: "PILOT_ERROR", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 2;
}

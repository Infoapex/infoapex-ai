using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using AiCodeControl.Cli;
using AiCodeControl.CodeIndexer.Services;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using AiCodeControl.Memory.Models;
using AiCodeControl.Memory.Services;
using AiCodeControl.PythonIndexer.Services;
using AiCodeControl.RefactorGuard.Services;
using AiCodeControl.RustIndexer.Services;

var requestedRepoRoot = GetOptionValue(args, "--repo");
var repoRoot = string.IsNullOrWhiteSpace(requestedRepoRoot)
    ? PathResolver.ResolveRepoRoot()
    : Path.GetFullPath(requestedRepoRoot);

if (args.Length == 0)
{
    PrintHelp();
    return 1;
}

var command = args[0].Trim().ToLowerInvariant();

try
{
    return await RunCommandAsync();
}
catch (Exception ex)
{
    WriteJson(new { status = "error", error = ex.GetType().Name, message = ex.Message });
    return 1;
}

async Task<int> RunCommandAsync()
{
    var configLoader = new ConfigLoader();

    switch (command)
    {
        case "init":
            {
                var template = GetOptionValue(args, "--template");
                List<string> created = new(), skipped = new();
                if (!string.IsNullOrWhiteSpace(template))
                    (created, skipped) = InitTemplates.Apply(repoRoot, template);

                var config = configLoader.LoadCodeControl(repoRoot);
                var dbInitializer = new DatabaseInitializer();
                var codegraphPath = dbInitializer.InitializeCodegraph(repoRoot, ResolveCodegraphDbPath(config));
                var memoryPath = dbInitializer.InitializeMemory(repoRoot, ResolveMemoryDbPath(LoadMemoryConfig()?.Memory));
                WriteJson(new
                {
                    status = "ok",
                    repoRoot,
                    codegraphDatabase = codegraphPath,
                    memoryDatabase = memoryPath,
                    template = string.IsNullOrWhiteSpace(template) ? null : template,
                    createdFiles = created,
                    skippedExistingFiles = skipped
                });
                return 0;
            }
        case "health":
            {
                var config = configLoader.LoadCodeControl(repoRoot);
                var codegraphPath = ResolveCodegraphDbPath(config)
                    ?? Path.Combine(repoRoot, ".ai-code-control", "db", "codegraph.sqlite");
                if (!Path.IsPathRooted(codegraphPath))
                    codegraphPath = Path.Combine(repoRoot, codegraphPath);
                var memoryPath = Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
                var available = File.Exists(codegraphPath) && File.Exists(memoryPath);
                WriteJson(new
                {
                    schemaVersion = "1.0",
                    status = available ? "ok" : "error",
                    error = available ? null : "The codegraph or memory cache is unavailable.",
                    available,
                    version = "1.2.0",
                    detail = available ? "ai-code-control caches are available." : "Run refresh before compiling context."
                });
                return available ? 0 : 2;
            }
        case "health-check":
            {
                var config = configLoader.LoadCodeControl(repoRoot);
                WriteJson(new HealthCheckService().Build(repoRoot, config));
                return 0;
            }
        case "run-validation":
            {
                var config = configLoader.LoadCodeControl(repoRoot);
                var summary = await new ValidationRunner().RunAsync(repoRoot, config);
                var failed = summary.Results.Any(r => r.Status is "fail" or "timeout");
                WriteJson(new { status = failed ? "fail" : "pass", results = summary.Results });
                return failed ? 2 : 0;
            }
        case "index-python":
            {
                var dbPath = EnsureCodegraphDb(configLoader);
                var path = GetOptionValue(args, "--path") ?? ".";
                var result = new PythonIndexerService().Index(repoRoot, path, dbPath);
                WriteJson(new { status = "ok", language = "python", path, result.FilesIndexed, result.SymbolsIndexed, result.ReferencesIndexed, result.EdgesIndexed, result.ImportsIndexed });
                return 0;
            }
        case "index-rust":
            {
                var dbPath = EnsureCodegraphDb(configLoader);
                var path = GetOptionValue(args, "--path") ?? ".";
                var result = new RustIndexerService().Index(repoRoot, path, dbPath);
                WriteJson(new { status = "ok", language = "rust", path, result.CratesIndexed, result.DependenciesIndexed, result.FilesIndexed, result.SymbolsIndexed, result.ReferencesIndexed, result.EdgesIndexed });
                return 0;
            }
        case "index-code":
            {
                var config = configLoader.LoadCodeControl(repoRoot);
                var dbPath = EnsureCodegraphDb(configLoader);
                var path = GetOptionValue(args, "--path") ?? ".";
                var full = args.Contains("--full", StringComparer.OrdinalIgnoreCase);
                var result = new CodeIndexerService().Index(
                    repoRoot,
                    path,
                    dbPath,
                    config?.Indexing?.Exclude,
                    full);
                WriteJson(new { status = "ok", result });
                return 0;
            }
        case "obsidian-export":
            {
                var databasePath = EnsureCodegraphDb(configLoader);
                var outputPath = GetOptionValue(args, "--out") ?? "docs/code-map/generated";
                var scopePath = GetOptionValue(args, "--path") ?? ".";
                var maxSymbols = int.TryParse(GetOptionValue(args, "--max-symbols"), out var parsedMaxSymbols)
                    ? parsedMaxSymbols
                    : 250;
                var result = new ObsidianExportService().Export(new ObsidianExportOptions
                {
                    RepositoryRoot = repoRoot,
                    DatabasePath = databasePath,
                    ScopePath = scopePath,
                    OutputPath = outputPath,
                    IncludeSymbols = args.Contains("--include-symbols", StringComparer.OrdinalIgnoreCase),
                    MaxSymbols = maxSymbols,
                    IncludeAdvisory = args.Contains("--include-advisory", StringComparer.OrdinalIgnoreCase),
                    IncludeSuperseded = args.Contains("--include-superseded", StringComparer.OrdinalIgnoreCase)
                });
                WriteJson(result);
                return 0;
            }
        case "trace-ingest":
            {
                var manifestPath = GetOptionValue(args, "--manifest");
                if (string.IsNullOrWhiteSpace(manifestPath))
                {
                    WriteJson(new { status = "error", message = "Usage: trace-ingest --manifest <path> [--expected-commit <commit>] [--no-code-index] [--dry-run]" });
                    return 1;
                }
                var sourceCommit = GetOptionValue(args, "--expected-commit") ?? TryReadGitCommit(repoRoot);
                if (string.IsNullOrWhiteSpace(sourceCommit))
                {
                    WriteJson(new { status = "error", message = "A source commit is required; use --expected-commit in repositories without Git." });
                    return 1;
                }
                var databasePath = EnsureCodegraphDb(configLoader);
                var request = new TraceGraphIngestManifestService().CreateRequest(
                    repoRoot, databasePath, manifestPath, sourceCommit, DateTimeOffset.UtcNow,
                    args.Contains("--no-code-index", StringComparer.OrdinalIgnoreCase) ? false : null);
                var ingest = new TraceGraphIngestService().Build(request);
                var blocking = ingest.Diagnostics.Any(item => item.Severity == "error");
                TraceGraphState? state = null;
                if (!blocking && !args.Contains("--dry-run", StringComparer.OrdinalIgnoreCase))
                    state = new TraceGraphRepository().Rebuild(databasePath, [ingest.Snapshot]);
                WriteJson(new
                {
                    status = blocking ? "fail" : args.Contains("--dry-run", StringComparer.OrdinalIgnoreCase) ? "dry_run" : "ok",
                    sourceCommit,
                    includeCodeIndex = request.IncludeCodeIndex,
                    ingest.DocumentsRead,
                    ingest.DocumentsSkipped,
                    ingest.NodesProduced,
                    ingest.EdgesProduced,
                    diagnostics = ingest.Diagnostics,
                    graphDigest = state?.Digest,
                    currentNodes = state?.Nodes.Count,
                    currentEdges = state?.Edges.Count
                });
                return blocking ? 2 : 0;
            }
        case "find-symbol":
            {
                var dbPath = EnsureCodegraphDb(configLoader);
                var symbol = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--symbol");
                if (string.IsNullOrWhiteSpace(symbol))
                {
                    WriteJson(new { status = "error", message = "Missing symbol query. Usage: find-symbol <query> | find-symbol --symbol <query>" });
                    return 1;
                }

                var service = new SymbolQueryService();
                if (args.Contains("--json", StringComparer.OrdinalIgnoreCase))
                {
                    var matches = service.FindSymbolMatches(dbPath, symbol);
                    WriteJson(new
                    {
                        schemaVersion = "1.0",
                        status = "ok",
                        error = (string?)null,
                        matches = matches.Select(item => new
                        {
                            symbol = item.FullName,
                            file = item.File,
                            line = (int?)item.StartLine
                        })
                    });
                    return 0;
                }

                WriteJson(service.FindSymbol(dbPath, symbol));
                return 0;
            }
        case "impact":
        case "impact-analysis":
            {
                var dbPath = EnsureCodegraphDb(configLoader);
                var symbol = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--symbol");
                if (string.IsNullOrWhiteSpace(symbol))
                {
                    WriteJson(new { status = "error", message = "Missing symbol for impact analysis. Usage: impact-analysis <symbol>" });
                    return 1;
                }

                var depth = int.TryParse(GetOptionValue(args, "--depth"), out var parsedDepth) ? parsedDepth : 5;
                var analysis = new SymbolQueryService().ImpactAnalysis(dbPath, symbol, depth);
                if (command == "impact" || args.Contains("--json", StringComparer.OrdinalIgnoreCase))
                {
                    var element = JsonSerializer.SerializeToElement(analysis);
                    var analysisStatus = element.TryGetProperty("status", out var statusElement)
                        ? statusElement.GetString()
                        : null;
                    var affectedFiles = element.TryGetProperty("impacts", out var impactsElement)
                        ? impactsElement.EnumerateArray()
                            .Select(item => item.TryGetProperty("file", out var file) ? file.GetString() : null)
                            .Where(file => !string.IsNullOrWhiteSpace(file))
                            .Distinct(StringComparer.OrdinalIgnoreCase)
                            .ToArray()
                        : Array.Empty<string?>();
                    var risk = element.TryGetProperty("riskLevel", out var riskElement)
                        ? riskElement.GetString()
                        : null;
                    var ok = string.Equals(analysisStatus, "ok", StringComparison.OrdinalIgnoreCase);
                    WriteJson(new
                    {
                        schemaVersion = "1.0",
                        status = ok ? "ok" : "error",
                        error = ok ? null : $"Impact analysis returned {analysisStatus ?? "an unknown status"}.",
                        symbol = ok && element.TryGetProperty("target", out var targetElement)
                            ? targetElement.GetString()
                            : null,
                        affectedFiles = ok ? affectedFiles : null,
                        provenance = ok && element.TryGetProperty("provenance", out var provenanceElement)
                            ? (JsonElement?)provenanceElement : null,
                        riskNotes = ok && !string.IsNullOrWhiteSpace(risk)
                            ? new[] { $"riskLevel:{risk}" }
                            : Array.Empty<string>()
                    });
                    return ok ? 0 : 2;
                }

                WriteJson(analysis);
                return 0;
            }
        case "trace":
        case "why":
        case "affected":
        case "current":
        case "evidence-for":
            {
                var entity = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--entity");
                if (string.IsNullOrWhiteSpace(entity))
                {
                    WriteJson(new
                    {
                        status = "error",
                        message = $"Missing entity. Usage: {command} <entity> [--depth <1-10>] [--max-nodes <1-200>] [--max-edges <1-500>] [--include-advisory]"
                    });
                    return 1;
                }

                var depth = int.TryParse(GetOptionValue(args, "--depth"), out var parsedDepth) ? parsedDepth : 3;
                var maximumNodes = int.TryParse(GetOptionValue(args, "--max-nodes"), out var parsedNodes) ? parsedNodes : 50;
                var maximumEdges = int.TryParse(GetOptionValue(args, "--max-edges"), out var parsedEdges) ? parsedEdges : 100;
                var expectedCommit = args.Contains("--skip-freshness", StringComparer.OrdinalIgnoreCase)
                    ? null
                    : GetOptionValue(args, "--expected-commit") ?? TryReadGitCommit(repoRoot);
                var options = new TraceGraphQueryOptions(
                    depth, maximumNodes, maximumEdges,
                    args.Contains("--include-advisory", StringComparer.OrdinalIgnoreCase),
                    expectedCommit);
                WriteJson(new TraceGraphQueryService().Query(EnsureCodegraphDb(configLoader), command, entity, options));
                return 0;
            }
        case "graph-drift":
            {
                var format = GetOptionValue(args, "--format") ?? "json";
                if (!string.Equals(format, "json", StringComparison.OrdinalIgnoreCase))
                {
                    WriteJson(new { status = "error", message = "graph-drift currently supports only --format json." });
                    return 1;
                }
                var minimumCoverage = decimal.TryParse(
                    GetOptionValue(args, "--minimum-coverage"),
                    NumberStyles.Number,
                    CultureInfo.InvariantCulture,
                    out var parsedCoverage)
                    ? parsedCoverage
                    : 100m;
                var expectedCommit = args.Contains("--skip-freshness", StringComparer.OrdinalIgnoreCase)
                    ? null
                    : GetOptionValue(args, "--expected-commit") ?? TryReadGitCommit(repoRoot);
                var report = new TraceGraphDriftService().Check(new TraceGraphDriftOptions(
                    RepositoryRoot: repoRoot,
                    DatabasePath: EnsureCodegraphDb(configLoader),
                    ScopePath: GetOptionValue(args, "--scope") ?? ".",
                    ExpectedSourceCommit: expectedCommit,
                    SourceManifestPath: GetOptionValue(args, "--sources"),
                    ExpectedGraphPath: GetOptionValue(args, "--expected-graph"),
                    ProjectionManifestPath: GetOptionValue(args, "--projection-manifest"),
                    MinimumCoveragePercent: minimumCoverage));
                WriteJson(report);
                var failOnReview = args.Contains("--fail-on-review", StringComparer.OrdinalIgnoreCase);
                return report.Status == "FAIL" || (failOnReview && report.Status == "REVIEW_REQUIRED") ? 2 : 0;
            }
        case "context-compile":
            {
                var manifestPathValue = GetOptionValue(args, "--manifest");
                var manifestSha256 = GetOptionValue(args, "--manifest-sha256");
                var taskId = GetOptionValue(args, "--task");
                if (string.IsNullOrWhiteSpace(manifestPathValue) ||
                    string.IsNullOrWhiteSpace(manifestSha256) ||
                    string.IsNullOrWhiteSpace(taskId))
                {
                    WriteJson(new
                    {
                        status = "error",
                        message = "Usage: context-compile --manifest <path> --manifest-sha256 <sha256> --task <id> [--maximum-tokens <n>] [--repo <path>]"
                    });
                    return 1;
                }

                var manifestPath = Path.IsPathRooted(manifestPathValue)
                    ? manifestPathValue
                    : Path.Combine(repoRoot, manifestPathValue);
                var maximumTokens = int.TryParse(GetOptionValue(args, "--maximum-tokens"), out var parsedMaximumTokens)
                    ? parsedMaximumTokens
                    : 12_000;
                var config = configLoader.LoadCodeControl(repoRoot);
                var configuredCodegraph = ResolveCodegraphDbPath(config);
                var fallbackCodegraph = Path.Combine(repoRoot, ".ai-code-control", "db", "codegraph.sqlite");
                var codegraph = configuredCodegraph is not null && File.Exists(configuredCodegraph)
                    ? configuredCodegraph
                    : File.Exists(fallbackCodegraph) ? fallbackCodegraph : null;
                var package = new ContextPackageCompiler().Compile(new ContextPackageCompilationOptions(
                    RepositoryRoot: repoRoot,
                    ManifestPath: manifestPath,
                    ManifestSha256: manifestSha256,
                    TaskId: taskId,
                    MaximumTokens: maximumTokens,
                    CodegraphDatabasePath: codegraph));
                Console.WriteLine(ContextPackageJson.Serialize(package));
                return 0;
            }
        case "verify-changed-files":
            {
                var planPath = GetOptionValue(args, "--plan") ?? ".ai-code-control/reports/refactor/current-plan.json";
                var config = configLoader.LoadCodeControl(repoRoot);
                var guard = new RefactorGuardService();
                var plan = guard.LoadPlan(repoRoot, planPath);
                var verify = guard.VerifyChangedFiles(repoRoot, plan, config);
                WriteJson(verify);
                return verify.Status == "pass" ? 0 : 2;
            }
        case "refactor-guard":
            {
                var planPath = GetOptionValue(args, "--plan") ?? ".ai-code-control/reports/refactor/current-plan.json";
                var config = configLoader.LoadCodeControl(repoRoot);
                var guard = new RefactorGuardService();
                var plan = guard.LoadPlan(repoRoot, planPath);
                var result = await guard.RunRefactorGuard(repoRoot, plan, config);
                WriteJson(result);

                var status = GetStatus(result);
                return status == "pass" ? 0 : 2;
            }
        case "memory-init":
            {
                var memConfig = LoadMemoryConfig();
                var memDbPath = new DatabaseInitializer().InitializeMemory(repoRoot, ResolveMemoryDbPath(memConfig?.Memory));
                var memRoot = Path.Combine(repoRoot, ".ai-code-control", "memory");
                Directory.CreateDirectory(Path.Combine(memRoot, "decisions"));
                Directory.CreateDirectory(Path.Combine(memRoot, "tasks"));
                Directory.CreateDirectory(Path.Combine(memRoot, "summaries"));
                var pmPath = Path.Combine(memRoot, "project-memory.md");
                if (!File.Exists(pmPath))
                    File.WriteAllText(pmPath, "# Project Memory\n\n## Summary\n\n## Current status\n\n## Next actions\n");
                WriteJson(new
                {
                    status = "ok",
                    memoryDatabase = memDbPath,
                    memoryRoot = Path.GetRelativePath(repoRoot, memRoot).Replace('\\', '/')
                });
                return 0;
            }
        case "memory-ingest":
            {
                var memConfig = LoadMemoryConfig();
                if (memConfig?.Memory == null)
                {
                    WriteJson(new { status = "error", message = "memory-control.json not found or has no \"memory\" section. Run memory-init and create the config first." });
                    return 1;
                }

                var memDbPath = ResolveMemoryDbPath(memConfig.Memory)
                    ?? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
                if (!File.Exists(memDbPath))
                {
                    WriteJson(new { status = "error", message = $"Memory database not found at {memDbPath}. Run 'memory-init' first." });
                    return 1;
                }

                var result = new MemoryIngestService().Ingest(repoRoot, memConfig.Memory);
                WriteJson(new
                {
                    status = result.Errors.Count == 0 ? "ok" : "partial",
                    ingested = result.Ingested,
                    skipped = result.Skipped,
                    pruned = result.Pruned,
                    errors = result.Errors
                });
                return result.Errors.Count == 0 ? 0 : 1;
            }
        case "memory-prune":
            {
                var memConfig = LoadMemoryConfig();
                if (memConfig?.Memory == null)
                {
                    WriteJson(new { status = "error", message = "memory-control.json not found. Run memory-init first." });
                    return 1;
                }

                var pruned = new MemoryIngestService().Prune(repoRoot, memConfig.Memory);
                WriteJson(new { status = "ok", pruned });
                return 0;
            }
        case "memory-search":
            {
                var query = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--query");
                if (string.IsNullOrWhiteSpace(query))
                {
                    WriteJson(new { status = "error", message = "Missing search query. Usage: memory-search <query> [--limit <n>]" });
                    return 1;
                }
                var memConfig = LoadMemoryConfig();
                var memDbPath = ResolveMemoryDbPath(memConfig?.Memory)
                    ?? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
                var maxItems = int.TryParse(GetOptionValue(args, "--limit"), out var limit) && limit > 0
                    ? limit
                    : memConfig?.Memory?.MaxRecallItems ?? 8;
                WriteJson(new MemorySearchService().Search(memDbPath, query, maxItems));
                return 0;
            }
        case "brief":
            {
                var task = GetOptionValue(args, "--task") ?? GetPositionalArg(args, 1) ?? "";
                var memConfig = LoadMemoryConfig();
                if (memConfig?.Memory == null)
                {
                    WriteJson(new
                    {
                        schemaVersion = "1.0",
                        status = "error",
                        error = "memory-control.json not found.",
                        summary = (string?)null,
                        relevantFiles = (string[]?)null
                    });
                    return 2;
                }

                var summary = new MemoryBriefService().GenerateBrief(repoRoot, task, memConfig.Memory);
                var memoryDb = ResolveMemoryDbPath(memConfig.Memory)
                    ?? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
                var relevantFiles = new List<string>
                {
                    ".ai-code-control/memory/project-memory.md"
                };
                if (!string.IsNullOrWhiteSpace(task) && File.Exists(memoryDb))
                {
                    relevantFiles.AddRange(new MemorySearchService()
                        .Search(memoryDb, task, memConfig.Memory.MaxRecallItems)
                        .Matches.Select(item => item.SourcePath));
                }
                WriteJson(new
                {
                    schemaVersion = "1.0",
                    status = "ok",
                    error = (string?)null,
                    summary,
                    relevantFiles = relevantFiles
                        .Where(path => !string.IsNullOrWhiteSpace(path))
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .ToArray()
                });
                return 0;
            }
        case "memory-brief":
            {
                // Without a task description the brief switches to "recent mode"
                // (project memory + latest items) - used by SessionStart hooks.
                var task = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--task") ?? "";
                var memConfig = LoadMemoryConfig();
                if (memConfig?.Memory == null)
                {
                    WriteJson(new { status = "error", message = "memory-control.json not found. Run memory-init first." });
                    return 1;
                }
                var brief = new MemoryBriefService().GenerateBrief(repoRoot, task, memConfig.Memory);
                Console.Write(brief);
                return 0;
            }
        case "memory-health":
            {
                var memConfig = LoadMemoryConfig();
                var health = new MemoryHealthService().Check(repoRoot, memConfig?.Memory);
                WriteJson(health);
                var failOnStale = args.Contains("--fail-on-stale", StringComparer.OrdinalIgnoreCase);
                return failOnStale && health.Status != "ok" ? 2 : 0;
            }
        case "memory-tokens":
            {
                var memConfig = LoadMemoryConfig();
                if (memConfig?.Memory == null)
                {
                    WriteJson(new { status = "error", message = "memory-control.json not found. Run memory-init first." });
                    return 1;
                }

                var topItems = int.TryParse(GetOptionValue(args, "--top"), out var top) && top > 0 ? top : 10;
                var report = new MemoryTokenReportService().Report(repoRoot, memConfig.Memory, topItems);
                WriteJson(report);
                return 0;
            }
        case "refresh":
            {
                var config = configLoader.LoadCodeControl(repoRoot);
                var full = args.Contains("--full", StringComparer.OrdinalIgnoreCase);
                var scopes = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase)
                {
                    ["code"] = [GetOptionValue(args, "--path") ?? "."]
                };
                foreach (var (language, paths) in config?.Indexing?.Languages ?? new Dictionary<string, List<string>>())
                {
                    if (language is not ("rust" or "python"))
                        throw new InvalidOperationException($"Unsupported configured indexer: {language}");
                    scopes[language] = paths;
                }
                for (var i = 0; i < args.Length; i++)
                {
                    if (args[i] != "--language-scope") continue;
                    if (++i >= args.Length || !args[i].Contains('='))
                        throw new InvalidOperationException("Use --language-scope rust=path or python=path.");
                    var pair = args[i].Split('=', 2);
                    if (pair[0] is not ("rust" or "python"))
                        throw new InvalidOperationException($"Unsupported indexer: {pair[0]}");
                    if (!scopes.TryGetValue(pair[0], out var paths)) scopes[pair[0]] = paths = [];
                    paths.Add(pair[1]);
                }
                foreach (var (_, paths) in scopes)
                foreach (var path in paths)
                {
                    var absolute = Path.GetFullPath(Path.Combine(repoRoot, path));
                    if (!Directory.Exists(absolute) ||
                        !(absolute == repoRoot || absolute.StartsWith(repoRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
                        throw new InvalidOperationException($"Index scope must be an existing repository directory: {path}");
                }
                var memoryConfig = LoadMemoryConfig();
                if (memoryConfig?.Memory == null)
                {
                    WriteJson(new { status = "error", message = "memory-control.json not found." });
                    return 1;
                }

                var initializer = new DatabaseInitializer();
                var memoryDb = initializer.InitializeMemory(repoRoot, ResolveMemoryDbPath(memoryConfig.Memory));
                var codeDb = initializer.InitializeCodegraph(repoRoot, ResolveCodegraphDbPath(config));
                var memory = new MemoryIngestService().Ingest(repoRoot, memoryConfig.Memory);
                var code = new CodeIndexerService().Index(repoRoot, scopes["code"][0], codeDb,
                    config?.Indexing?.Exclude, full);
                var rust = new List<object>();
                var python = new List<object>();
                foreach (var path in scopes.GetValueOrDefault("rust") ?? [])
                    rust.Add(new { path, result = new RustIndexerService().Index(repoRoot, path, codeDb, full) });
                foreach (var path in scopes.GetValueOrDefault("python") ?? [])
                    python.Add(new { path, result = new PythonIndexerService().Index(repoRoot, path, codeDb, full) });
                if (memory.Errors.Count == 0)
                {
                    using var connection = new SqliteConnection($"Data Source={codeDb}");
                    connection.Open();
                    using var insert = connection.CreateCommand();
                    insert.CommandText = "INSERT INTO unified_refresh_runs(completed_at, mode, git_commit, indexers_json, scopes_json) VALUES($at, $mode, $commit, $indexers, $scopes)";
                    insert.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
                    insert.Parameters.AddWithValue("$mode", full ? "full" : "incremental");
                    insert.Parameters.AddWithValue("$commit", (object?)code.Commit ?? DBNull.Value);
                    insert.Parameters.AddWithValue("$indexers", JsonSerializer.Serialize(scopes.Keys.Order(StringComparer.Ordinal).ToArray()));
                    insert.Parameters.AddWithValue("$scopes", JsonSerializer.Serialize(scopes));
                    insert.ExecuteNonQuery();
                }
                if (args.Contains("--json", StringComparer.OrdinalIgnoreCase))
                {
                    var refreshed = memory.Errors.Count == 0;
                    WriteJson(new
                    {
                        schemaVersion = "1.0",
                        status = refreshed ? "ok" : "error",
                        error = refreshed ? null : string.Join("; ", memory.Errors),
                        refreshed,
                        mode = full ? "full" : "incremental",
                        indexers = scopes.Keys.Order(StringComparer.Ordinal).ToArray(),
                        scopes,
                        detail = refreshed
                            ? $"Memory ingested {memory.Ingested}; refreshed {scopes.Count} code indexers."
                            : "Refresh completed with memory errors."
                    });
                    return refreshed ? 0 : 2;
                }

                WriteJson(new
                {
                    status = memory.Errors.Count == 0 ? "ok" : "partial",
                    memoryDatabase = memoryDb,
                    codegraphDatabase = codeDb,
                    memory,
                    code, rust, python
                });
                return memory.Errors.Count == 0 ? 0 : 1;
            }
        case "memory-add-task-summary":
            {
                var title = GetOptionValue(args, "--title") ?? "task";
                var fromDiff = args.Contains("--from-current-git-diff", StringComparer.OrdinalIgnoreCase);
                var result = new MemoryTaskSummaryService().Create(repoRoot, title, fromDiff);
                WriteJson(new
                {
                    status = "ok",
                    path = result.Path,
                    fileName = result.FileName,
                    note = "Fill in the TODO fields and run memory-ingest to index."
                });
                return 0;
            }
        default:
            PrintHelp();
            return 1;
    }
}

string EnsureCodegraphDb(ConfigLoader configLoader)
{
    var config = configLoader.LoadCodeControl(repoRoot);
    var dbPath = ResolveCodegraphDbPath(config)
        ?? Path.Combine(repoRoot, ".ai-code-control", "db", "codegraph.sqlite");
    // Initialization is idempotent and also applies schema migrations to an existing cache.
    _ = new DatabaseInitializer().InitializeCodegraph(repoRoot, dbPath);
    return dbPath;
}

string? ResolveCodegraphDbPath(CodeControlConfig? config)
    => ResolveRepoPath(config?.Indexing?.Database);

string? ResolveMemoryDbPath(MemoryConfig? config)
    => ResolveRepoPath(config?.Store);

string? ResolveRepoPath(string? path)
{
    if (string.IsNullOrEmpty(path))
        return null;
    return Path.IsPathRooted(path)
        ? path
        : Path.Combine(repoRoot, path.Replace('/', Path.DirectorySeparatorChar));
}

MemoryControlConfig? LoadMemoryConfig() => new MemoryConfigLoader().Load(repoRoot);

static string? GetPositionalArg(string[] args, int index)
{
    // Skips option tokens (--key value) so "find-symbol --symbol Foo" does not
    // return the literal "--symbol" as the positional argument.
    var position = 0;
    for (var i = 0; i < args.Length; i++)
    {
        if (args[i].StartsWith("--", StringComparison.Ordinal))
        {
            var isBareFlag = string.Equals(args[i], "--from-current-git-diff", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--full", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--fail-on-stale", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--include-advisory", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--include-superseded", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--no-code-index", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--dry-run", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--skip-freshness", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--fail-on-review", StringComparison.OrdinalIgnoreCase);
            if (!isBareFlag && i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                i++;
            continue;
        }

        if (position == index)
            return args[i];
        position++;
    }

    return null;
}

static string? GetOptionValue(string[] args, string key)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (string.Equals(args[i], key, StringComparison.OrdinalIgnoreCase))
        {
            return args[i + 1];
        }
    }

    return null;
}

static string GetStatus(object result)
{
    var json = JsonSerializer.Serialize(result);
    using var doc = JsonDocument.Parse(json);
    return doc.RootElement.TryGetProperty("status", out var status) ? status.GetString() ?? "fail" : "fail";
}

static string? TryReadGitCommit(string repositoryRoot)
{
    try
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = repositoryRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("rev-parse");
        startInfo.ArgumentList.Add("HEAD");
        using var process = Process.Start(startInfo);
        if (process is null)
            return null;
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.StandardError.ReadToEnd();
        process.WaitForExit();
        return process.ExitCode == 0 && output.Length > 0 ? output : null;
    }
    catch
    {
        return null;
    }
}

static void WriteJson(object value)
{
    Console.WriteLine(JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
}

static void PrintHelp()
{
    Console.WriteLine("AiCodeControl CLI");
    Console.WriteLine("Commands:");
    Console.WriteLine("  init [--template dotnet-nextjs|python-rust|generic]");
    Console.WriteLine("  health-check");
    Console.WriteLine("  run-validation");
    Console.WriteLine("  index-python --path <path>");
    Console.WriteLine("  index-rust --path <path>");
    Console.WriteLine("  index-code [--path <path>] [--full]  # C#, TypeScript/JS and SQL");
    Console.WriteLine("  obsidian-export [--path <scope>] [--out <vault>] [--include-symbols] [--max-symbols <n>] [--include-advisory] [--include-superseded]");
    Console.WriteLine("  trace-ingest --manifest <path> [--expected-commit <commit>] [--no-code-index] [--dry-run]");
    Console.WriteLine("  find-symbol <query>");
    Console.WriteLine("  impact-analysis <symbol> [--depth <1-20>]");
    Console.WriteLine("  trace <entity> [--depth <1-10>] [--max-nodes <1-200>] [--max-edges <1-500>] [--include-advisory]");
    Console.WriteLine("  why <symbol-or-file> [bounded trace options]");
    Console.WriteLine("  affected <contract-or-adr> [bounded trace options]");
    Console.WriteLine("  current <adr-or-rule> [bounded trace options]");
    Console.WriteLine("  evidence-for <criterion-or-task> [bounded trace options]");
    Console.WriteLine("  graph-drift [--scope <path>] [--sources <manifest>] [--expected-graph <fixture>] [--projection-manifest <manifest>] [--minimum-coverage <0-100>] [--fail-on-review]");
    Console.WriteLine("  context-compile --manifest <path> --manifest-sha256 <sha256> --task <id> [--maximum-tokens <n>] [--repo <path>]");
    Console.WriteLine("  verify-changed-files --plan <path>");
    Console.WriteLine("  refactor-guard --plan <path>");
    Console.WriteLine("  memory-init");
    Console.WriteLine("  memory-ingest");
    Console.WriteLine("  memory-prune");
    Console.WriteLine("  memory-search <query> [--limit <n>]");
    Console.WriteLine("  memory-brief [task]        (no task = recent-memory brief)");
    Console.WriteLine("  memory-health [--fail-on-stale]");
    Console.WriteLine("  memory-tokens [--top <n>]            # token footprint of stored memory + brief");
    Console.WriteLine("  memory-add-task-summary --title <title> [--from-current-git-diff]");
    Console.WriteLine("  refresh [--path <path>] [--full]     # memory + code graph");
}

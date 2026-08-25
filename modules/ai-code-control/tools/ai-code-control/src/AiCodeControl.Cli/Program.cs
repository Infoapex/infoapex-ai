using System.Text.Json;
using AiCodeControl.Cli;
using AiCodeControl.CodeIndexer.Services;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using AiCodeControl.Memory.Models;
using AiCodeControl.Memory.Services;
using AiCodeControl.PythonIndexer.Services;
using AiCodeControl.RefactorGuard.Services;
using AiCodeControl.RustIndexer.Services;

var repoRoot = PathResolver.ResolveRepoRoot();

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
        case "find-symbol":
            {
                var dbPath = EnsureCodegraphDb(configLoader);
                var symbol = GetPositionalArg(args, 1) ?? GetOptionValue(args, "--symbol");
                if (string.IsNullOrWhiteSpace(symbol))
                {
                    WriteJson(new { status = "error", message = "Missing symbol query. Usage: find-symbol <query> | find-symbol --symbol <query>" });
                    return 1;
                }

                WriteJson(new SymbolQueryService().FindSymbol(dbPath, symbol));
                return 0;
            }
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
                WriteJson(new SymbolQueryService().ImpactAnalysis(dbPath, symbol, depth));
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
                var code = new CodeIndexerService().Index(
                    repoRoot,
                    GetOptionValue(args, "--path") ?? ".",
                    codeDb,
                    config?.Indexing?.Exclude,
                    args.Contains("--full", StringComparer.OrdinalIgnoreCase));
                WriteJson(new
                {
                    status = memory.Errors.Count == 0 ? "ok" : "partial",
                    memoryDatabase = memoryDb,
                    codegraphDatabase = codeDb,
                    memory,
                    code
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
    if (!File.Exists(dbPath))
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
                || string.Equals(args[i], "--fail-on-stale", StringComparison.OrdinalIgnoreCase);
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
    Console.WriteLine("  find-symbol <query>");
    Console.WriteLine("  impact-analysis <symbol> [--depth <1-20>]");
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

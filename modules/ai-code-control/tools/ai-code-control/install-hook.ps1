# AI Code Control - Pre-commit hook installer
# Run from repo root: .\tools\ai-code-control\install-hook.ps1
#
# What it installs:
#   .git/hooks/pre-commit  -- blocks commits when files outside current-plan.json are modified
#
# The hook is a POSIX sh script (required by Git, even on Windows).
# If the published binary exists it is used; otherwise 'dotnet run' is used as fallback.

param(
    [switch]$Force,
    [switch]$Uninstall,
    [string]$RepoRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (& git -C (Get-Location).Path rev-parse --show-toplevel 2>$null)
    if (-not $RepoRoot) {
        Write-Error 'Cannot find the target Git repository. Pass -RepoRoot explicitly.'
        exit 1
    }
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$ToolRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$HookDir    = Join-Path $RepoRoot ".git\hooks"
$HookFile   = Join-Path $HookDir "pre-commit"
$PlanPath   = ".ai-code-control/reports/refactor/current-plan.json"

if (-not $ToolRoot.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "Tool root must be inside target repository: $ToolRoot"
    exit 1
}
$ToolRelative = $ToolRoot.Substring($RepoRoot.Length).TrimStart([char[]]@([char]92, [char]47)).Replace([char]92, [char]47)
$CliProject = if ($ToolRelative) {
    "$ToolRelative/tools/ai-code-control/src/AiCodeControl.Cli"
} else {
    "tools/ai-code-control/src/AiCodeControl.Cli"
}
$PublishedBin = if ($ToolRelative) {
    "$ToolRelative/tools/ai-code-control/bin/publish/AiCodeControl.Cli"
} else {
    "tools/ai-code-control/bin/publish/AiCodeControl.Cli"
}

if (-not (Test-Path $HookDir)) {
    Write-Error "'.git/hooks' not found. Run this script from the repository root, or ensure it is a Git repository."
    exit 1
}

if ($Uninstall) {
    if (Test-Path $HookFile) {
        Remove-Item $HookFile -Force
        Write-Host "Pre-commit hook removed: $HookFile"
    } else {
        Write-Host "No pre-commit hook found at: $HookFile"
    }
    exit 0
}

if ((Test-Path $HookFile) -and -not $Force) {
    Write-Warning "Pre-commit hook already exists at: $HookFile"
    Write-Warning "Use -Force to overwrite."
    exit 1
}

# Detect whether the published binary exists to decide which invocation to use.
$PublishedBinFull = Join-Path $RepoRoot ($PublishedBin.Replace('/', [IO.Path]::DirectorySeparatorChar) + ".exe")
$PublishedDllFull = Join-Path $RepoRoot ($PublishedBin.Replace('/', [IO.Path]::DirectorySeparatorChar) + ".dll")
$UseNative = Test-Path -LiteralPath $PublishedBinFull
$UseDll = -not $UseNative -and (Test-Path -LiteralPath $PublishedDllFull)

if (-not $UseNative -and -not $UseDll) {
    $InvokeCmd = "dotnet run --project `"$CliProject`" --"
    Write-Host "Published binary not found. Hook will use 'dotnet run' (slower on first run)."
    Write-Host "To publish: dotnet publish $CliProject -c Release -o $($PublishedBin.Substring(0, $PublishedBin.LastIndexOf('/')))"
} elseif ($UseNative) {
    $InvokeCmd = "`"./${PublishedBin}.exe`""
    Write-Host "Published binary found: $PublishedBinFull"
} else {
    $InvokeCmd = "dotnet `"$PublishedBin.dll`""
    Write-Host "Published DLL found: $PublishedDllFull"
}

# The hook must be a POSIX sh script — Git executes it via sh.exe on Windows.
$HookContent = @"
#!/bin/sh
# AI Code Control - pre-commit guard (auto-installed by install-hook.ps1)
PLAN="$PlanPath"

if [ -f "`$PLAN" ]; then
  echo "AI Code Control: verifying changed files against current-plan.json ..."
  $InvokeCmd verify-changed-files --plan "`$PLAN"
  STATUS=`$?
  if [ `$STATUS -ne 0 ]; then
    echo ""
    echo "COMMIT BLOCKED: files outside allowedFiles or forbidden paths detected."
    echo "Fix the violations above, or update current-plan.json, then retry."
    exit 1
  fi
fi

exit 0
"@

# Write with LF line endings (required for sh scripts on Windows Git Bash).
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($HookFile, $HookContent.Replace("`r`n", "`n"), $Utf8NoBom)

Write-Host ""
Write-Host "Pre-commit hook installed: $HookFile"
Write-Host ""
Write-Host "How it works:"
Write-Host "  - On every 'git commit', checks if a current-plan.json exists."
Write-Host "  - If it does, runs 'verify-changed-files' and blocks the commit on violations."
Write-Host "  - If no plan file exists, the hook passes silently."
Write-Host ""
Write-Host "To test the hook: git commit --dry-run"
Write-Host "To remove the hook: .\tools\ai-code-control\install-hook.ps1 -Uninstall"

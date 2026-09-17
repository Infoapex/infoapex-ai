@echo off
rem Metadata-only test double: never invokes a model or executes a prompt.
if "%~1"=="--version" if "%~2"=="" (
  echo codex-cli 0.104.0
  exit /b 0
)
if "%~1"=="exec" if "%~2"=="--help" if "%~3"=="" (
  echo fixture capabilities: --json --cd --sandbox
  exit /b 0
)
echo Doctor fixture refuses execution >&2
exit /b 2

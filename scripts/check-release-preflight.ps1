param([string]$PythonCommand = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $PythonCommand) {
    $PythonCommand = Join-Path $root "backend/.venv/Scripts/python.exe"
    if (-not (Test-Path -LiteralPath $PythonCommand)) { $PythonCommand = "python" }
}
Push-Location $root
try {
    $checks = @(
        @("scripts/check-architecture.py"),
        @("scripts/check-mobile-pc-parity.py", "--check-doc", "docs/mobile-pc-parity.md"),
        @("scripts/export-mobile-context-policy.py", "--check"),
        @("scripts/export-mobile-prompt-contract.py", "--check")
    )
    foreach ($check in $checks) {
        & $PythonCommand @check
        if ($LASTEXITCODE -ne 0) { throw "Release preflight failed: $($check -join ' ')" }
    }
} finally { Pop-Location }

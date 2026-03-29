param(
    [string]$Workspace,
    [string]$Root
)

$ErrorActionPreference = 'Continue'

# Ensure log directory
$logDir  = Join-Path $Root "workspace\$Workspace\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "agent-realtime.log"
$pidFile = Join-Path $logDir "agent.pid"
$batFile = Join-Path $Root "run-copilotcli-loop.bat"

$host.UI.RawUI.WindowTitle = "Agent-$Workspace"

Write-Host "══════════════════════════════════════════" -ForegroundColor DarkMagenta
Write-Host "  爱丽丝 Agent  |  workspace: $Workspace" -ForegroundColor Cyan
Write-Host "  Log: $logFile" -ForegroundColor DarkCyan
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkMagenta
Write-Host ""

function Write-Log {
    param([string]$Line)
    $ts      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $logLine = "[$ts] $Line"
    Add-Content -Path $logFile -Value $logLine -Encoding UTF8
}

Write-Log "=== Agent started for workspace: $Workspace ==="

# Start the bat process with stdout+stderr redirected so we can tee
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = "cmd.exe"
$psi.Arguments              = "/c `"$batFile`" -workspace `"$Workspace`""
$psi.WorkingDirectory       = $Root
$psi.UseShellExecute        = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.Id | Set-Content -Path $pidFile -Encoding UTF8

# Capture log path as a plain string so it can cross the Task boundary (.NET only)
$capturedLog = [string]$logFile

# ANSI escape sequence pattern (VT100/VT220): covers CSI sequences and standalone ESC codes.
# Used to strip terminal control codes before writing to the plain-text log file.
$ansiPattern = '\x1b(\[[0-9;]*[A-Za-z]|[^[])'

# Stream stdout in a Task — must use only .NET methods (no PowerShell runspace in Task threads)
$stdoutJob = [System.Threading.Tasks.Task]::Run([System.Action]{
    try {
        $rdr = $proc.StandardOutput
        while (-not $rdr.EndOfStream) {
            $ln = $rdr.ReadLine()
            [Console]::WriteLine($ln)
            # Strip ANSI escape codes and carriage-returns before persisting to the log so the
            # Alith console receives readable plain text rather than terminal control sequences.
            $clean = [Text.RegularExpressions.Regex]::Replace($ln, $ansiPattern, '')
            $clean = $clean.Replace("`r", '').Trim()
            if ($clean.Length -gt 0) {
                $ts = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
                [IO.File]::AppendAllText($capturedLog, "[$ts] $clean`n", [Text.Encoding]::UTF8)
            }
        }
    } catch { }
})

# Stream stderr in a Task
$stderrJob = [System.Threading.Tasks.Task]::Run([System.Action]{
    try {
        $rdr = $proc.StandardError
        while (-not $rdr.EndOfStream) {
            $ln = $rdr.ReadLine()
            [Console]::WriteLine("[ERR] $ln")
            $clean = [Text.RegularExpressions.Regex]::Replace($ln, $ansiPattern, '')
            $clean = $clean.Replace("`r", '').Trim()
            if ($clean.Length -gt 0) {
                $ts = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
                [IO.File]::AppendAllText($capturedLog, "[$ts] [ERR] $clean`n", [Text.Encoding]::UTF8)
            }
        }
    } catch { }
})

$proc.WaitForExit()
try { $stdoutJob.Wait() } catch { }
try { $stderrJob.Wait() } catch { }

Write-Log "=== Agent exited (code $($proc.ExitCode)) for workspace: $Workspace ==="

Remove-Item -Path $pidFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "══ Agent exited (code $($proc.ExitCode)) ══" -ForegroundColor Yellow
Write-Host "Press any key to close this window..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

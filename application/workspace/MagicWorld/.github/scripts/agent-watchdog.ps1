<#
.SYNOPSIS
    Agent watchdog — monitors a workspace agent for stalls and kills it if stuck.

.DESCRIPTION
    Runs alongside the agent CLI process. Polls the agent's realtime log file mtime.
    If the log hasn't been updated in $StallMinutes, kills all CLI node.exe processes
    for this workspace, allowing the outer bat loop to restart the agent cleanly.

.PARAMETER Workspace
    Workspace name (used for PID file lookup and log messages).

.PARAMETER LogFile
    Path to the workspace's agent-realtime.log file.

.PARAMETER StallMinutes
    Minutes of log silence before the watchdog kills the agent. Default: 30.

.EXAMPLE
    Start-Process powershell -ArgumentList "-File agent-watchdog.ps1 -Workspace pioneer -LogFile C:\...\agent-realtime.log -StallMinutes 30" -WindowStyle Hidden
#>
param(
    [string]$Workspace    = 'unknown',
    [string]$LogFile      = '',
    [int]   $StallMinutes = 30
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-WatchdogLog([string]$msg) {
    if ($LogFile -and (Test-Path (Split-Path $LogFile))) {
        $ts = [DateTime]::Now.ToString('yyyy.MM.dd-HH:mm:ss')
        [IO.File]::AppendAllText($LogFile, "[$ts] [WATCHDOG] $msg`n", [Text.Encoding]::UTF8)
    }
}

# Read PID from agent.pid if available
$pidFile = if ($LogFile) { Join-Path (Split-Path $LogFile) 'agent.pid' } else { $null }

Write-WatchdogLog "Started. Workspace=$Workspace StallMinutes=$StallMinutes"

$stallThreshold = [TimeSpan]::FromMinutes($StallMinutes)
$pollIntervalSec = 60   # check every 60 seconds
$startTime = [DateTime]::Now

while ($true) {
    Start-Sleep -Seconds $pollIntervalSec

    # Give agent at least StallMinutes to produce initial output
    if (([DateTime]::Now - $startTime).TotalMinutes -lt $StallMinutes) { continue }

    if (-not $LogFile -or -not (Test-Path $LogFile)) { continue }

    $logStat  = Get-Item $LogFile -ErrorAction SilentlyContinue
    if (-not $logStat) { continue }

    $silence = [DateTime]::Now - $logStat.LastWriteTime

    if ($silence -gt $stallThreshold) {
        Write-WatchdogLog "STALL DETECTED: no log output for $([Math]::Round($silence.TotalMinutes, 1)) min (threshold=$StallMinutes min)"

        # Find the agent PID from pid file
        $agentPid = $null
        if ($pidFile -and (Test-Path $pidFile)) {
            $raw = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
            $agentPid = [int]($raw -replace '\s','')
        }

        if ($agentPid) {
            Write-WatchdogLog "Killing agent process tree rooted at PID $agentPid"
            # Kill the cmd.exe process and its children
            $procs = Get-CimInstance Win32_Process | Where-Object {
                $_.ProcessId -eq $agentPid -or $_.ParentProcessId -eq $agentPid
            }
            foreach ($p in $procs) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                Write-WatchdogLog "Killed PID $($p.ProcessId) ($($p.Name))"
            }
            Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue
        } else {
            # Fallback: kill any node.exe running copilot for this workspace
            Write-WatchdogLog "No PID file found, watchdog cannot kill — no action taken"
        }

        # Watchdog job is done after one intervention; outer bat loop handles restart
        Write-WatchdogLog "Watchdog exiting after intervention"
        exit 0
    }
}

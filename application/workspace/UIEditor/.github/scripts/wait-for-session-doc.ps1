$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$timeoutSeconds = 30
$continuous = $false
$workspace = $null

if ($args.Count -gt 0) {
    $parsedTimeout = 0
    if ([int]::TryParse($args[0], [ref]$parsedTimeout) -and $parsedTimeout -gt 0) {
        $timeoutSeconds = $parsedTimeout
    }
}

if ($args.Count -gt 1 -and $args[1] -eq "continuous") {
    $continuous = $true
}

# args[2] = rootDir override (from bat), args[3] = workspace name
if ($args.Count -gt 2 -and $args[2]) { $repoRoot = $args[2].TrimEnd('\') }
if ($args.Count -gt 3 -and $args[3]) { $workspace = $args[3] }

# Resolve workspace: arg > .active-workspace file > legacy root sessions/
if (-not $workspace) {
    $wsFile = Join-Path $repoRoot ".active-workspace"
    if (Test-Path $wsFile) { $workspace = (Get-Content $wsFile -Raw).Trim() }
}

if ($workspace) {
    $sessionsDir = Join-Path $repoRoot "workspace\$workspace\sessions"
    $logFile     = Join-Path $repoRoot "workspace\$workspace\logs\agent-realtime.log"
} else {
    $sessionsDir = Join-Path $repoRoot "sessions"
    $logFile     = $null
}

if (-not (Test-Path $sessionsDir)) {
    New-Item -ItemType Directory -Path $sessionsDir -Force | Out-Null
}

# Heartbeat: write to realtime log every 5 minutes during continuous wait
$heartbeatIntervalSec = 300
$lastHeartbeat = [DateTime]::MinValue

function Write-Heartbeat {
    if ($logFile) {
        $ts = [DateTime]::Now.ToString('yyyy.MM.dd-HH:mm:ss')
        [IO.File]::AppendAllText($logFile, "[$ts] [HEARTBEAT] Waiting for new tasks in $workspace/sessions/`n", [Text.Encoding]::UTF8)
    }
}

while ($true) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)

    if (Get-ChildItem -Path $sessionsDir -Filter *.md -File -ErrorAction SilentlyContinue | Select-Object -First 1) {
        @{ status = "found"; path = $sessionsDir; workspace = $workspace } | ConvertTo-Json -Compress
        exit 0
    }

    $watcher = New-Object System.IO.FileSystemWatcher $sessionsDir, "*.md"
    $watcher.IncludeSubdirectories = $false
    $watcher.EnableRaisingEvents = $true

    $createdSource = "WaitForSessionDocCreated"
    $renamedSource = "WaitForSessionDocRenamed"

    Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $createdSource | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier $renamedSource | Out-Null

    try {
        while ((Get-Date) -lt $deadline) {
            $remainingMs = [int][Math]::Max(0, ($deadline - (Get-Date)).TotalMilliseconds)
            $event = Wait-Event -Timeout ([Math]::Min(1, [Math]::Ceiling($remainingMs / 1000)))

            if ($event) {
                Remove-Event -SourceIdentifier $event.SourceIdentifier -ErrorAction SilentlyContinue
                @{ status = "found"; path = $sessionsDir; workspace = $workspace } | ConvertTo-Json -Compress
                exit 0
            }

            # Heartbeat every 5 minutes during continuous wait
            if ($continuous -and ([DateTime]::Now - $lastHeartbeat).TotalSeconds -ge $heartbeatIntervalSec) {
                Write-Heartbeat
                $lastHeartbeat = [DateTime]::Now
            }
        }
    } finally {
        Unregister-Event -SourceIdentifier $createdSource -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $renamedSource -ErrorAction SilentlyContinue
        $watcher.Dispose()
    }

    if (-not $continuous) {
        @{ status = "timeout"; path = $sessionsDir; workspace = $workspace; timeoutSeconds = $timeoutSeconds } | ConvertTo-Json -Compress
        exit 0
    }
}
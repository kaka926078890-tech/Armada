# Armada hooks installer (Windows): copy spooler + merge %USERPROFILE%\.cursor\hooks.json.
# Does not require Python/Node. WinPS 5.1 JavaScriptSerializer keeps arrays as arrays.
$ErrorActionPreference = 'Stop'

$hooksDir = Join-Path $env:USERPROFILE '.cursor\hooks'
$hooksJson = Join-Path $env:USERPROFILE '.cursor\hooks.json'
$scriptSrc = Join-Path $PSScriptRoot 'armada-spool.ps1'
$scriptDst = Join-Path $hooksDir 'armada-spool.ps1'

if (-not (Test-Path -LiteralPath $scriptSrc)) {
  Write-Error "missing $scriptSrc"
  exit 1
}

New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
Copy-Item -Force -LiteralPath $scriptSrc -Destination $scriptDst

$events = @(
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit',
  'afterAgentResponse', 'afterAgentThought', 'subagentStart', 'subagentStop',
  'preCompact', 'stop'
)

Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

$root = $null
if (Test-Path -LiteralPath $hooksJson) {
  $stamp = [int]([DateTime]::UtcNow - [DateTime]::SpecifyKind([DateTime]'1970-01-01', 'Utc')).TotalSeconds
  Copy-Item -LiteralPath $hooksJson -Destination ($hooksJson + '.bak.' + $stamp)
  try {
    $rawText = [System.IO.File]::ReadAllText($hooksJson)
    $root = $ser.DeserializeObject($rawText)
  } catch {
    $root = $null
  }
}
if ($null -eq $root) {
  $root = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $root['version'] = 1
}

if (-not $root.ContainsKey('hooks') -or $null -eq $root['hooks']) {
  $root['hooks'] = New-Object 'System.Collections.Generic.Dictionary[string,object]'
}
$hooks = $root['hooks']

function Test-Ours($cmd) {
  return ($cmd -is [string] -and ($cmd.Contains('armada-spool.ps1') -or $cmd.Contains('armada-spool.sh')))
}

function Hook-Command([string]$script, [string]$event) {
  $posix = $script -replace '\\', '/'
  return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $posix + '" ' + $event
}

foreach ($event in $events) {
  $lst = New-Object System.Collections.ArrayList
  if ($hooks.ContainsKey($event) -and $null -ne $hooks[$event]) {
    foreach ($e in @($hooks[$event])) { [void]$lst.Add($e) }
  }
  $want = Hook-Command $scriptDst $event
  $kept = New-Object System.Collections.ArrayList
  $hasExact = $false
  foreach ($e in $lst) {
    $cmd = $null
    if ($e -is [System.Collections.IDictionary]) { $cmd = $e['command'] }
    elseif ($e.command) { $cmd = $e.command }
    if (Test-Ours $cmd) {
      $timeout = 5
      if ($e -is [System.Collections.IDictionary] -and $null -ne $e['timeout']) { $timeout = $e['timeout'] }
      elseif ($e.timeout) { $timeout = $e.timeout }
      if ($cmd -eq $want -and $timeout -eq 5) {
        $hasExact = $true
        [void]$kept.Add($e)
      }
    } else {
      [void]$kept.Add($e)
    }
  }
  if (-not $hasExact) {
    $entry = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $entry['command'] = $want
    $entry['timeout'] = 5
    [void]$kept.Add($entry)
  }
  $hooks[$event] = $kept.ToArray()
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hooksJson, $ser.Serialize($root), $utf8)
Write-Host "hooks 已安装: $scriptDst"
Write-Host "下一步: 在 Cursor 里 Install from VSIX（armada-agent ≥ 0.3.8）→ Ctrl+Shift+P → Armada: Configure Hub Connection → Reload Window"
Write-Host "之后每天请用 scripts\armada-cursor.ps1 打开工作区，不要点图标启动。"

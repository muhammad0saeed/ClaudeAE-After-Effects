<#
  ClaudeAE installer for Windows.

  .\scripts\install.ps1                          install the After Effects extension
  .\scripts\install.ps1 -ClaudeDesktop           ...and connect Claude Desktop (MCP)
  .\scripts\install.ps1 -ClaudeCode -Skill       ...and Claude Code + the claude-motion skill
  .\scripts\install.ps1 -All                     everything
  .\scripts\install.ps1 -Uninstall               remove the extension and the MCP entries

  The extension is linked (not copied) into %APPDATA%\Adobe\CEP\extensions, so updating this
  folder updates the panel. Restart After Effects after installing.
#>
param(
  [switch]$ClaudeDesktop,
  [switch]$ClaudeCode,
  [switch]$Skill,
  [switch]$All,
  [switch]$NoRegistry,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ExtSrc = Join-Path $Root 'extension'
$ExtDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$ExtDest = Join-Path $ExtDir 'com.claudeae'
if ($All) { $ClaudeDesktop = $true; $ClaudeCode = $true; $Skill = $true }

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

function Remove-Link($p) {
  if (-not (Test-Path -LiteralPath $p)) { return }
  $item = Get-Item -LiteralPath $p -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir "$p" | Out-Null     # removes only the link, never the target
  } else {
    $bak = "$p.backup-$(Get-Date -Format yyyyMMddHHmmss)"
    Rename-Item -LiteralPath $p -NewName (Split-Path $bak -Leaf)
    Say "  existing folder moved to $bak" 'Yellow'
  }
}

# ---------------------------------------------------------------- node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Say 'Node.js 18+ is required (https://nodejs.org). Install it and run this again.' 'Red'; exit 1 }
$ver = (& node -v).Trim()
if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 18) { Say "Node.js $ver is too old - install Node.js 18 or newer." 'Red'; exit 1 }

if ($Uninstall) {
  Say 'Removing ClaudeAE...' 'Cyan'
  Remove-Link $ExtDest
  & node (Join-Path $Root 'scripts\configure.js') --uninstall
  Say 'Done. Restart After Effects / Claude Desktop.' 'Green'
  exit 0
}

Say "ClaudeAE installer  ($Root)" 'Cyan'
Say "Node.js $ver"

# ------------------------------------------------------- npm packages
if (-not (Test-Path (Join-Path $Root 'node_modules\@anthropic-ai\sdk'))) {
  Say 'Installing npm packages...'
  Push-Location $Root
  try { & npm install --omit=dev --no-audit --no-fund | Out-Host } finally { Pop-Location }
}

# ------------------------------------------------- unsigned CEP panels
if (-not $NoRegistry) {
  foreach ($v in 9..13) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    $cur = $null
    try { $cur = (Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction Stop).PlayerDebugMode } catch { }
    if ($cur -ne '1') {
      if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
      New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
      Say "  enabled unsigned extensions for CSXS.$v"
    }
  }
}

# ------------------------------------------------------- extension link
New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
Remove-Link $ExtDest
New-Item -ItemType Junction -Path $ExtDest -Target $ExtSrc | Out-Null
Say "[ok] After Effects extension linked: $ExtDest" 'Green'

& node (Join-Path $Root 'scripts\configure.js') --root
if ($ClaudeDesktop) { & node (Join-Path $Root 'scripts\configure.js') --desktop }
if ($ClaudeCode) { & node (Join-Path $Root 'scripts\configure.js') --code }
if ($Skill) { & node (Join-Path $Root 'scripts\configure.js') --skill }

Say ''
Say 'Next:' 'Cyan'
Say '  1. Restart After Effects.'
Say '  2. Window > Extensions > Claude AE  (the MCP bridge also starts on its own with AE).'
if (-not $ClaudeDesktop) { Say '  3. To use the Claude desktop app: run again with -ClaudeDesktop, or use the panel''s Connect tab.' }
else { Say '  3. Quit and reopen Claude Desktop, then ask Claude to "check the After Effects connection".' }

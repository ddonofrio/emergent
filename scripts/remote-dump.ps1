param(
    [ValidateSet('Summary', 'Agent', 'Full')]
    [string]$Scope = 'Summary',
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$UniverseId = 'first-shore',
    [ValidatePattern('^(active|[0-9a-f-]{36})$')]
    [string]$World = 'active',
    [ValidatePattern('^[A-Za-z0-9 _.-]*$')]
    [string]$Agent,
    [ValidateRange(1, 10000)]
    [int]$Limit = 100,
    [string]$OutputPath,
    [string]$RemoteHost = '74.208.72.196',
    [ValidateRange(1, 65535)]
    [int]$RemotePort = 22022,
    [string]$RemoteUser = 'guile',
    [string]$IdentityFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Scope -eq 'Agent' -and [string]::IsNullOrWhiteSpace($Agent)) {
    throw '-Agent is required when Scope is Agent.'
}

function Quote-RemoteArgument([string]$Value) {
    return "'" + $Value + "'"
}

$sshArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', [string]$RemotePort)
if (-not [string]::IsNullOrWhiteSpace($IdentityFile)) {
    $resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
    $sshArguments += @('-i', $resolvedIdentity)
}

$remoteArguments = @(
    '--data-dir', '/var/lib/emergent',
    '--universe', $UniverseId,
    '--world', $World,
    '--scope', $Scope.ToLowerInvariant(),
    '--limit', [string]$Limit
)
if ($Scope -eq 'Agent') {
    $remoteArguments += @('--agent', $Agent.Trim())
}
$quotedArguments = ($remoteArguments | ForEach-Object { Quote-RemoteArgument $_ }) -join ' '
$command = "cd /var/www/emergent/current && /usr/local/bin/node --import tsx scripts/dump-world.ts $quotedArguments"
$target = "$RemoteUser@$RemoteHost"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    & ssh @sshArguments $target $command
    if ($LASTEXITCODE -ne 0) { throw "Remote dump failed with exit code $LASTEXITCODE." }
    exit 0
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $resolvedOutput
if (-not [string]::IsNullOrEmpty($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
& ssh @sshArguments $target $command | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Remote dump failed with exit code $LASTEXITCODE." }
Write-Host "Dump written to $resolvedOutput"

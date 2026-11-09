param(
    [string]$DataDir,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$UniverseId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$envFile = Join-Path $projectRoot '.env'

function Get-EnvValue([string]$Name, [string]$Fallback) {
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return $Fallback
    }

    $value = $null
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match $pattern) {
            $value = $Matches[1].Trim()
        }
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Fallback
    }
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Get-EnvValue 'DATA_DIR' 'data'
}
$resolvedDataDir = if ([System.IO.Path]::IsPathRooted($DataDir)) {
    [System.IO.Path]::GetFullPath($DataDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $DataDir))
}
$worldsRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedDataDir 'worlds'))
$activePath = Join-Path $worldsRoot 'active.json'
$worldId = $null
if (Test-Path -LiteralPath $activePath -PathType Leaf) {
    $activeConfig = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
    $activeProperty = $activeConfig.active.PSObject.Properties[$UniverseId]
    if ($null -eq $activeProperty -or $activeProperty.Value -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw "The active world for $UniverseId is missing or invalid in $activePath"
    }
    $worldId = [string]$activeProperty.Value
}

$worldPath = if ($null -ne $worldId) {
    [System.IO.Path]::GetFullPath((Join-Path (Join-Path $worldsRoot $worldId) "$UniverseId.sqlite"))
} else {
    [System.IO.Path]::GetFullPath((Join-Path $resolvedDataDir "$UniverseId.sqlite"))
}
$dataPrefix = $resolvedDataDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $worldPath.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete a recording outside the configured data directory: $worldPath"
}

$targets = @($worldPath, "$worldPath-wal", "$worldPath-shm", "$worldPath-journal")
$existing = @($targets | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
if ($existing.Count -eq 0) {
    Write-Host "The active $UniverseId world is already empty."
    exit 0
}

try {
    foreach ($target in $existing) {
        Remove-Item -LiteralPath $target -Force
    }
} catch {
    throw "Could not reset the active world. Stop the Emergent server and run this script again. $($_.Exception.Message)"
}

Write-Host "Deleted the active $UniverseId world recording."
Write-Host 'The world metadata and every other world were preserved.'
Write-Host 'The next server start will regenerate this world from its saved seed.'

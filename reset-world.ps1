param(
    [string]$DataDir,
    [string]$ModuleId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
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
if ([string]::IsNullOrWhiteSpace($ModuleId)) {
    $ModuleId = Get-EnvValue 'EMERGENT_MODULE' 'first-shore'
}
if ($ModuleId -notmatch '^[a-z0-9-]+$') {
    throw "Invalid module ID: $ModuleId"
}

$resolvedDataDir = if ([System.IO.Path]::IsPathRooted($DataDir)) {
    [System.IO.Path]::GetFullPath($DataDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $DataDir))
}
$worldPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedDataDir "$ModuleId.sqlite"))
$projectPrefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$savedWorlds = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'data\worlds'))
$savedWorldsPrefix = $savedWorlds.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $worldPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete a world outside the project: $worldPath"
}
if ($worldPath.StartsWith($savedWorldsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete a saved world: $worldPath"
}

$targets = @($worldPath, "$worldPath-wal", "$worldPath-shm", "$worldPath-journal")
$existing = @($targets | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
if ($existing.Count -eq 0) {
    Write-Host "The active $ModuleId world is already empty."
    exit 0
}

try {
    foreach ($target in $existing) {
        Remove-Item -LiteralPath $target -Force
    }
} catch {
    throw "Could not reset the active world. Stop the Emergent server and run this script again. $($_.Exception.Message)"
}

Write-Host "Deleted the active $ModuleId recording."
Write-Host 'Saved worlds in data\worlds were preserved.'
Write-Host 'The next server start will generate a clean world from the module seed.'

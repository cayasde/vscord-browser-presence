param(
    [string]$SdkRoot = $env:DISCORD_SOCIAL_SDK_ROOT
)

$ErrorActionPreference = "Stop"

if (-not $SdkRoot) {
    throw "Set DISCORD_SOCIAL_SDK_ROOT to the extracted Discord Social SDK directory."
}

$SdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot "include\discordpp.h"))) {
    $nestedSdkRoot = Join-Path $SdkRoot "discord_social_sdk"
    if (Test-Path -LiteralPath (Join-Path $nestedSdkRoot "include\discordpp.h")) {
        $SdkRoot = $nestedSdkRoot
    }
}

$includePath = Join-Path $SdkRoot "include"
$libraryPath = Join-Path $SdkRoot "lib\release"
$runtimePath = Join-Path $SdkRoot "bin\release\discord_partner_sdk.dll"
$compiler = Get-Command "g++" -ErrorAction Stop
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repositoryRoot "native\bin\win32-x64"
$outputExecutable = Join-Path $outputDirectory "vscord-social-sdk-host.exe"

if (-not (Test-Path -LiteralPath (Join-Path $includePath "discordpp.h"))) {
    throw "The SDK root does not contain include\discordpp.h: $SdkRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $libraryPath "discord_partner_sdk.lib"))) {
    throw "The SDK root does not contain the Windows x64 release import library."
}
if (-not (Test-Path -LiteralPath $runtimePath)) {
    throw "The SDK root does not contain bin\release\discord_partner_sdk.dll."
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$compilerArguments = @(
    "-std=c++17",
    "-O2",
    "-DDISCORD_API=__declspec(dllimport)",
    "-I",
    $includePath,
    (Join-Path $repositoryRoot "native\social_sdk_host.cpp"),
    "-L",
    $libraryPath,
    "-ldiscord_partner_sdk",
    "-o",
    $outputExecutable
)

& $compiler.Source @compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "Building the Discord Social SDK host failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath $runtimePath -Destination $outputDirectory -Force
Write-Output "Built $outputExecutable"

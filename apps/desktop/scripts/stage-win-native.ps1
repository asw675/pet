$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The Windows helpers require x64 Windows and PowerShell 7.'
}

$desktop = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $desktop 'native/publish/win-x64'
$voice = Join-Path $publish 'voice'
$inspect = Join-Path $publish 'launch-inspect'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('pet-native-' + [guid]::NewGuid())
$whisperCommit = '306c88f4d1286aec1bf96e544632897886af5501'

New-Item -ItemType Directory -Path $work, $voice, $inspect -Force | Out-Null
try {
    $whisperSource = Join-Path $work 'whisper-source'
    $whisperBuild = Join-Path $work 'whisper-build'
    git init --quiet $whisperSource
    git -C $whisperSource fetch --quiet --depth 1 https://github.com/ggml-org/whisper.cpp.git $whisperCommit
    git -C $whisperSource checkout --quiet --detach FETCH_HEAD
    if ((git -C $whisperSource rev-parse HEAD) -ne $whisperCommit) { throw 'Unexpected Whisper source revision.' }
    cmake -S $whisperSource -B $whisperBuild -G 'Visual Studio 17 2022' -A x64 `
        -DBUILD_SHARED_LIBS=OFF -DGGML_STATIC=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF `
        -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=OFF
    cmake --build $whisperBuild --config Release --target whisper-cli --parallel 2
    $whisper = Join-Path $whisperBuild 'bin/Release/whisper-cli.exe'
    & $whisper --help 2>&1 | Out-Null

    $inspectBuild = Join-Path $work 'launch-inspect'
    cmake -S (Join-Path $desktop 'native/launch-inspect') -B $inspectBuild -G 'Visual Studio 17 2022' -A x64
    cmake --build $inspectBuild --config Release --parallel 2

    $sapiOut = Join-Path $work 'sapi'
    $dotnetArtifacts = Join-Path $work 'dotnet'
    dotnet publish (Join-Path $desktop 'native/sapi-helper/PetDesktopSapi.csproj') -c Release -r win-x64 --self-contained true `
        -p:UseArtifactsOutput=true "-p:ArtifactsPath=$dotnetArtifacts" -o $sapiOut

    Copy-Item -LiteralPath $whisper -Destination (Join-Path $voice 'whisper-cli.exe') -Force
    Copy-Item -LiteralPath (Join-Path $whisperSource 'LICENSE') -Destination (Join-Path $voice 'whisper-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $sapiOut 'pet-desktop-sapi.exe') -Destination (Join-Path $voice 'pet-desktop-sapi.exe') -Force
    Copy-Item -LiteralPath (Join-Path $inspectBuild 'Release/launch-inspect.exe') -Destination (Join-Path $inspect 'launch-inspect.exe') -Force
    node (Join-Path $PSScriptRoot 'native-artifact-pins.mjs') --require-all
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}

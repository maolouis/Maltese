# 把 examples/plugins 下的每个插件打成一个独立 zip，供插件中心「安装插件」直接装。
# 用法：powershell -File scripts/pack-plugins.ps1 [-OutputDir <目录>]
# 默认输出到仓库的 dist-plugins\，可以指到安装目录的 plugins\ 方便本机安装。
param(
    [string]$OutputDir = "dist-plugins"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repo "examples\plugins"
$out = $OutputDir
if (-not [System.IO.Path]::IsPathRooted($out)) {
    $out = Join-Path $repo $out
}
New-Item -ItemType Directory -Force -Path $out | Out-Null

Get-ChildItem -LiteralPath $sourceRoot -Directory | ForEach-Object {
    $manifest = Join-Path $_.FullName "plugin.json"
    if (-not (Test-Path -LiteralPath $manifest)) {
        Write-Warning "跳过 $($_.Name)：没有 plugin.json"
        return
    }
    $zip = Join-Path $out ($_.Name + ".zip")
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    # zip 里带一层同名目录，解压后即插件根目录
    Compress-Archive -LiteralPath $_.FullName -DestinationPath $zip -CompressionLevel Optimal
    Write-Output "$($_.Name).zip  $((Get-Item -LiteralPath $zip).Length) bytes -> $out"
}

# deploy.ps1 — 部署 ShellFix 插件到 OpenCode
# 用法: .\deploy.ps1
# 前置条件：源码必须通过 LSP diagnostics（零错误）

$ErrorActionPreference = "Stop"

$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configDir = "$env:USERPROFILE\.config\opencode"
$pluginDir = Join-Path $configDir "plugins"
$tuiDir = Join-Path $configDir "tui-plugins"
$backupDir = Join-Path $pluginDir ".bak"
$tuiJson = Join-Path $configDir "tui.json"
$tuiEntry = "./tui-plugins/shell-fix-tui.ts"

# 核心插件（shell.env / tool.execute 钩子）→ plugins\
$coreFiles = @("shell-fix.ts")
# TUI 调度器（palette / 事件订阅，tui.json 注册）→ tui-plugins\
$tuiFiles = @("shell-fix-tui.ts")
# 公共库（版本号等）→ plugins\lib\（TUI 插件经 ../plugins/lib/* 引用）
$libFiles = @("state.ts", "template-store.ts", "auto-rules.ts", "codemap-mcp.ts", "codemap-indexer.ts", "toast-alerts.ts")

Write-Host "ShellFix 部署脚本" -ForegroundColor Cyan
Write-Host "=================" -ForegroundColor Cyan

# 1. 源文件存在性检查（前置）
Write-Host "[1/5] 检查源文件..." -NoNewline
$hasErrors = $false
foreach ($f in ($coreFiles + $tuiFiles)) {
  $srcPath = Join-Path $srcDir "src" $f
  if (-not (Test-Path $srcPath)) {
    Write-Host " ❌ 缺少文件: $srcPath" -ForegroundColor Red
    $hasErrors = $true
  }
}
foreach ($f in $libFiles) {
  $srcPath = Join-Path $srcDir "src" "lib" $f
  if (-not (Test-Path $srcPath)) {
    Write-Host " ❌ 缺少文件: $srcPath" -ForegroundColor Red
    $hasErrors = $true
  }
}
if ($hasErrors) { exit 1 }
Write-Host " OK" -ForegroundColor Green

# 2. 备份现有插件（含 tui.json）
Write-Host "[2/5] 备份现有插件..." -NoNewline
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
foreach ($f in $coreFiles) {
  $target = Join-Path $pluginDir $f
  if (Test-Path $target) {
    Copy-Item -Path $target -Destination (Join-Path $backupDir "${timestamp}_${f}") -Force
  }
}
foreach ($f in $tuiFiles) {
  $target = Join-Path $tuiDir $f
  if (Test-Path $target) {
    Copy-Item -Path $target -Destination (Join-Path $backupDir "${timestamp}_${f}") -Force
  }
}
foreach ($f in $libFiles) {
  $target = Join-Path $pluginDir "lib" $f
  if (Test-Path $target) {
    Copy-Item -Path $target -Destination (Join-Path $backupDir "${timestamp}_lib_${f}") -Force
  }
}
if (Test-Path $tuiJson) {
  Copy-Item -Path $tuiJson -Destination (Join-Path $backupDir "${timestamp}_tui.json") -Force
}
Write-Host " OK (备份到 .bak\)" -ForegroundColor Green

# 3. 复制新文件
Write-Host "[3/5] 部署新版本..." -NoNewline
# 核心插件 → plugins\
foreach ($f in $coreFiles) {
  $srcPath = Join-Path $srcDir "src" $f
  $target = Join-Path $pluginDir $f
  Copy-Item -Path $srcPath -Destination $target -Force
}
# TUI 插件 → tui-plugins\（tui.json 注册的加载路径）
if (-not (Test-Path $tuiDir)) { New-Item -ItemType Directory -Path $tuiDir -Force | Out-Null }
foreach ($f in $tuiFiles) {
  $srcPath = Join-Path $srcDir "src" $f
  $target = Join-Path $tuiDir $f
  Copy-Item -Path $srcPath -Destination $target -Force
}
# lib 文件（版本号等公共服务）→ plugins\lib\（TUI 插件通过 ../plugins/lib/* 引用）
$libTarget = Join-Path $pluginDir "lib"
if (-not (Test-Path $libTarget)) { New-Item -ItemType Directory -Path $libTarget -Force | Out-Null }
foreach ($f in $libFiles) {
  $srcPath = Join-Path $srcDir "src" "lib" $f
  $target = Join-Path $libTarget $f
  Copy-Item -Path $srcPath -Destination $target -Force
}
Write-Host " OK" -ForegroundColor Green

# 4. 校验/写入 TUI 注册（tui.json）
Write-Host "[4/5] 校验 TUI 注册 (tui.json)..." -NoNewline
$tuiConfig = $null
if (Test-Path $tuiJson) {
  try { $tuiConfig = Get-Content $tuiJson -Raw | ConvertFrom-Json } catch { $tuiConfig = $null }
}
if ($null -eq $tuiConfig) { $tuiConfig = [pscustomobject]@{ plugin = @() } }
if (-not $tuiConfig.PSObject.Properties.Match("plugin")) {
  $tuiConfig | Add-Member -NotePropertyName "plugin" -NotePropertyValue @()
}
$pluginList = @($tuiConfig.plugin)
if ($pluginList -notcontains $tuiEntry) {
  $pluginList += $tuiEntry
  $tuiConfig.plugin = $pluginList
  $json = $tuiConfig | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($tuiJson, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Host " OK (已写入 $tuiEntry)" -ForegroundColor Green
} else {
  Write-Host " OK (条目已存在)" -ForegroundColor Green
}

# 5. 提示重启
Write-Host "[5/5] 完成!" -ForegroundColor Green
Write-Host ""
# 读取版本号
$stateTs = Get-Content (Join-Path $srcDir "src" "lib" "state.ts") -Raw
$versionMatch = [regex]::Match($stateTs, 'PLUGIN_VERSION\s*=\s*"([^"]+)"')
$version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "unknown" }

Write-Host "✅ ShellFix v${version} 已部署到 $pluginDir + $tuiDir" -ForegroundColor Cyan
Write-Host "✅ TUI 注册: $tuiJson → $tuiEntry" -ForegroundColor Cyan
Write-Host "⚠️  请重启 OpenCode 使新插件生效" -ForegroundColor Yellow
Write-Host "⚠️  如需回滚: Copy-Item .bak\${timestamp}_shell-fix.ts plugins\ ; Copy-Item .bak\${timestamp}_shell-fix-tui.ts tui-plugins\ ; Copy-Item .bak\${timestamp}_tui.json $configDir" -ForegroundColor Yellow

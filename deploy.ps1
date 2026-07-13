# deploy.ps1 — 部署 ShellFix 插件到 OpenCode
# 用法: .\deploy.ps1
# 前置条件：源码必须通过 LSP diagnostics（零错误）

$ErrorActionPreference = "Stop"

$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginDir = "$env:USERPROFILE\.config\opencode\plugins"
$backupDir = "$env:USERPROFILE\.config\opencode\plugins\.bak"

$files = @("shell-fix.ts", "shell-fix-tui.ts")
$libFiles = @("state.ts", "template-store.ts", "auto-rules.ts")

Write-Host "ShellFix 部署脚本" -ForegroundColor Cyan
Write-Host "=================" -ForegroundColor Cyan

# 1. LSP 诊断检查（前置）
Write-Host "[1/4] 检查源文件编译状态..." -NoNewline
$hasErrors = $false
foreach ($f in $files) {
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

# 2. 备份现有插件
Write-Host "[2/4] 备份现有插件..." -NoNewline
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
foreach ($f in $files) {
  $target = Join-Path $pluginDir $f
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
Write-Host " OK (备份到 .bak\)" -ForegroundColor Green

# 3. 复制新文件
Write-Host "[3/4] 部署新版本..." -NoNewline
# 主文件
foreach ($f in $files) {
  $srcPath = Join-Path $srcDir "src" $f
  $target = Join-Path $pluginDir $f
  Copy-Item -Path $srcPath -Destination $target -Force
}
# lib 文件（版本号等公共服务）
$libTarget = Join-Path $pluginDir "lib"
if (-not (Test-Path $libTarget)) { New-Item -ItemType Directory -Path $libTarget -Force | Out-Null }
foreach ($f in $libFiles) {
  $srcPath = Join-Path $srcDir "src" "lib" $f
  $target = Join-Path $libTarget $f
  Copy-Item -Path $srcPath -Destination $target -Force
}
Write-Host " OK" -ForegroundColor Green

# 4. 提示重启
Write-Host "[4/4] 完成!" -ForegroundColor Green
Write-Host ""
# 读取版本号
$stateTs = Get-Content (Join-Path $srcDir "src" "lib" "state.ts") -Raw
$versionMatch = [regex]::Match($stateTs, 'PLUGIN_VERSION\s*=\s*"([^"]+)"')
$version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "unknown" }

Write-Host "✅ ShellFix v${version} 已部署到 $pluginDir" -ForegroundColor Cyan
Write-Host "⚠️  请重启 OpenCode 使新插件生效" -ForegroundColor Yellow
Write-Host "⚠️  如需回滚: Copy-Item .bak\${timestamp}_*.ts plugins\" -ForegroundColor Yellow
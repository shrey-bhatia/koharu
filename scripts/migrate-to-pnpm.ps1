# Koharu npm/bun to pnpm Migration Script
# This script cleans up old package manager artifacts and installs with pnpm

Write-Host ""
Write-Host "=== Koharu npm/bun to pnpm Migration ===" -ForegroundColor Cyan
Write-Host ""

# Check if pnpm is installed
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host "ERROR: pnpm not found!" -ForegroundColor Red
    Write-Host "Install pnpm first:" -ForegroundColor Yellow
    Write-Host "  npm install -g pnpm" -ForegroundColor Gray
    Write-Host "  OR" -ForegroundColor Gray
    Write-Host "  Visit https://pnpm.io/installation" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

$pnpmVersion = pnpm --version
Write-Host "[OK] pnpm $pnpmVersion detected" -ForegroundColor Green
Write-Host ""

# Step 1: Remove bun.lock
Write-Host "[1/4] Removing bun.lock..." -ForegroundColor Yellow
if (Test-Path "bun.lock") {
    Remove-Item "bun.lock" -Force
    Write-Host "  + Deleted bun.lock" -ForegroundColor Green
} else {
    Write-Host "  - bun.lock not found (already clean)" -ForegroundColor Gray
}
Write-Host ""

# Step 2: Remove all node_modules directories
Write-Host "[2/4] Cleaning node_modules directories..." -ForegroundColor Yellow
$nodeModulesPaths = @(
    ".\node_modules",
    ".\next\node_modules"
)

$removedCount = 0
foreach ($path in $nodeModulesPaths) {
    if (Test-Path $path) {
        Write-Host "  Removing: $path" -ForegroundColor Gray
        Remove-Item $path -Recurse -Force
        $removedCount++
    }
}

if ($removedCount -gt 0) {
    Write-Host "  + Removed $removedCount node_modules directories" -ForegroundColor Green
} else {
    Write-Host "  - No node_modules found (already clean)" -ForegroundColor Gray
}
Write-Host ""

# Step 3: Install dependencies with pnpm
Write-Host "[3/4] Installing dependencies with pnpm..." -ForegroundColor Yellow
Write-Host "  This may take a few minutes..." -ForegroundColor Gray
Write-Host ""

try {
    pnpm install
    Write-Host ""
    Write-Host "  + Dependencies installed successfully" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "  ERROR: pnpm install failed" -ForegroundColor Red
    Write-Host "  Check the error messages above" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
Write-Host ""

# Step 4: Verify installation
Write-Host "[4/4] Verifying installation..." -ForegroundColor Yellow

$verifyPaths = @(
    ".\node_modules",
    ".\pnpm-lock.yaml"
)

$allGood = $true
foreach ($path in $verifyPaths) {
    if (Test-Path $path) {
        Write-Host "  + $path exists" -ForegroundColor Green
    } else {
        Write-Host "  X $path missing!" -ForegroundColor Red
        $allGood = $false
    }
}

Write-Host ""
if ($allGood) {
    Write-Host "=== Migration Complete! ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Test the build: pnpm tauri build -- --features=cuda --no-bundle" -ForegroundColor Gray
    Write-Host "  2. Or run dev mode: pnpm tauri dev" -ForegroundColor Gray
    Write-Host ""
    Write-Host "PNPM Benefits:" -ForegroundColor Cyan
    Write-Host "  - Shared dependency store saves 60-80% disk space" -ForegroundColor Gray
    Write-Host "  - Faster installs with content-addressable storage" -ForegroundColor Gray
    Write-Host "  - Strict dependency resolution prevents phantom deps" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "=== Migration Failed ===" -ForegroundColor Red
    Write-Host "Some files are missing. Try running pnpm install manually." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

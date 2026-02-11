# Koharu Setup Script
# Downloads required PaddleOCR models and verifies CUDA/cuDNN configuration.
# Run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

param(
    [switch]$SkipModels,
    [switch]$SkipCudaCheck,
    [string]$Language = "chinese"  # chinese (covers Japanese), english, latin, korean, etc.
)

$ErrorActionPreference = "Stop"

Write-Host "=== Koharu Setup ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check CUDA & cuDNN ---
if (-not $SkipCudaCheck) {
    Write-Host "[1/4] Checking CUDA & cuDNN..." -ForegroundColor Yellow

    $cudaPath = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    $cudnnPath = "C:\Program Files\NVIDIA\CUDNN"

    # Find CUDA
    $cudaVersions = @()
    if (Test-Path $cudaPath) {
        $cudaVersions = Get-ChildItem $cudaPath -Directory | Select-Object -ExpandProperty Name
    }
    if ($cudaVersions.Count -eq 0) {
        Write-Host "  WARNING: CUDA toolkit not found at $cudaPath" -ForegroundColor Red
        Write-Host "  Install from: https://developer.nvidia.com/cuda-toolkit" -ForegroundColor Red
    } else {
        foreach ($v in $cudaVersions) {
            $binDir = "$cudaPath\$v\bin"
            if (Test-Path $binDir) {
                Write-Host "  Found CUDA $v" -ForegroundColor Green
                # Check if in PATH
                $inPath = $env:PATH -split ';' | Where-Object { $_ -eq $binDir }
                if (-not $inPath) {
                    Write-Host "  WARNING: $binDir is NOT in PATH" -ForegroundColor Red
                }
            }
        }
    }

    # Find cuDNN
    $cudnnVersions = @()
    if (Test-Path $cudnnPath) {
        $cudnnDlls = Get-ChildItem $cudnnPath -Recurse -Filter "cudnn64_9.dll" -ErrorAction SilentlyContinue
        foreach ($dll in $cudnnDlls) {
            $binDir = $dll.DirectoryName
            Write-Host "  Found cuDNN: $binDir" -ForegroundColor Green

            # Check if in PATH
            $inPath = $env:PATH -split ';' | Where-Object { $_ -eq $binDir }
            if (-not $inPath) {
                Write-Host "  WARNING: cuDNN bin dir is NOT in PATH!" -ForegroundColor Red
                Write-Host "  Fix: Add '$binDir' to your PATH environment variable" -ForegroundColor Yellow
                Write-Host "  Quick fix (current user):" -ForegroundColor Yellow
                Write-Host "    `$userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')" -ForegroundColor Gray
                Write-Host "    [System.Environment]::SetEnvironmentVariable('PATH', `"`$userPath;$binDir`", 'User')" -ForegroundColor Gray
            } else {
                Write-Host "  cuDNN is correctly in PATH" -ForegroundColor Green
            }
        }
    }
    if ($cudnnDlls.Count -eq 0) {
        Write-Host "  WARNING: cuDNN not found!" -ForegroundColor Red
        Write-Host "  Install from: https://developer.nvidia.com/cudnn" -ForegroundColor Red
    }
    Write-Host ""
}

# --- 2. Check Python ---
Write-Host "[2/4] Checking Python & huggingface_hub..." -ForegroundColor Yellow
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") {
            $pythonCmd = $cmd
            Write-Host "  Found: $ver" -ForegroundColor Green
            break
        }
    } catch {}
}
if (-not $pythonCmd) {
    Write-Host "  ERROR: Python 3 not found. Install from https://python.org" -ForegroundColor Red
    exit 1
}

# Install huggingface_hub if needed
try {
    & $pythonCmd -m pip install huggingface_hub --quiet --disable-pip-version-check 2>&1 | Out-Null
} catch {
    Write-Host "  WARNING: Could not auto-install huggingface_hub. Install manually:" -ForegroundColor Yellow
    Write-Host "    $pythonCmd -m pip install huggingface_hub" -ForegroundColor Yellow
}
Write-Host "  huggingface_hub ready" -ForegroundColor Green
Write-Host ""

# --- 3. Download PaddleOCR models ---
if (-not $SkipModels) {
    Write-Host "[3/4] Downloading PaddleOCR models (language: $Language)..." -ForegroundColor Yellow

    $scriptRoot = Split-Path -Parent $PSCommandPath
    & $pythonCmd "$scriptRoot\download_models.py" $Language
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Model download failed" -ForegroundColor Red
        Write-Host "  Try running manually: python scripts/download_models.py $Language" -ForegroundColor Yellow
        exit 1
    }
    Write-Host ""
} else {
    Write-Host "[3/4] Skipping model download (-SkipModels)" -ForegroundColor Gray
    Write-Host ""
}

# --- 4. Check sccache ---
Write-Host "[4/4] Checking build tools..." -ForegroundColor Yellow
$sccache = Get-Command sccache -ErrorAction SilentlyContinue
if ($sccache) {
    Write-Host "  sccache: installed" -ForegroundColor Green
    Write-Host "  To enable: uncomment [build] section in .cargo/config.toml" -ForegroundColor Gray
} else {
    Write-Host "  sccache: not installed (optional, speeds up rebuilds)" -ForegroundColor Gray
    Write-Host "  Install: cargo install sccache" -ForegroundColor Gray
}

$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if ($rustc) {
    $ver = rustc --version
    Write-Host "  rustc: $ver" -ForegroundColor Green
} else {
    Write-Host "  ERROR: Rust not found! Install from https://rustup.rs" -ForegroundColor Red
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) {
    $ver = pnpm --version
    Write-Host "  pnpm: $ver" -ForegroundColor Green
} else {
    Write-Host "  ERROR: pnpm not found! Install from https://pnpm.io" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Build commands:" -ForegroundColor White
Write-Host "  Development:  pnpm tauri dev" -ForegroundColor Gray
Write-Host "  Release:      pnpm tauri build -- --features=cuda" -ForegroundColor Gray
Write-Host "  Quick test:   pnpm tauri build -- --features=cuda --no-bundle" -ForegroundColor Gray

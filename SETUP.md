# Koharu Setup Guide

Complete setup instructions for building and running the Koharu manga translation project.

## Quick Start

```powershell
# 1. Run the automated setup
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# 2. Build the project
pnpm tauri build -- --features=cuda

# 3. The installer will be in target/release/bundle/
```

## Prerequisites

### Required
- **Windows** (currently unsupported on macOS/Linux)
- **CUDA 12.9** — Install from https://developer.nvidia.com/cuda-toolkit
- **cuDNN 9.11** — Install from https://developer.nvidia.com/cudnn
- **Rust 1.85+** — Install from https://rustup.rs
- **pnpm 8.0+** — Install from https://pnpm.io or via `npm install -g pnpm`
- **Python 3.9+** — Install from https://python.org
- **NVIDIA GPU** — Works best with RTX/GTX series (A100/H100/L40S for production)

### Optional  
- **sccache** — Dramatically speeds up Rust rebuild times (install: `cargo install sccache`)

## Installation Steps

### 1. Install CUDA & cuDNN (if not already done)

**CUDA 12.9:**
```
1. Download from https://developer.nvidia.com/cuda-toolkit
2. Run the installer and select "Add CUDA to PATH"
3. Verify: In PowerShell, `nvcc --version` should show CUDA 12.9
```

**cuDNN 9.11:**
```
1. Download from https://developer.nvidia.com/cudnn
2. Extract and locate: C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9
3. Verify cuDNN is in PATH: This is done automatically by the setup script
```

### 2. Clone & Install Dependencies

```bash
git clone https://github.com/mayocream/koharu.git
cd koharu

# Install Rust and pnpm if not already installed
# Then install project dependencies
pnpm install
```

### 3. Run Automated Setup

```powershell
# From the koharu root directory
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

This script will:
- ✓ Verify CUDA 12.9 and cuDNN 9.11 are installed and in PATH
- ✓ Add cuDNN to your user PATH (if missing)
- ✓ Check Python 3 installation
- ✓ Install `huggingface_hub` Python package
- ✓ Download PP-OCRv5 Chinese/Japanese models (~165 MB)
- ✓ Create PaddleOCR configuration  
- ✓ Verify Rust, Bun, and other build tools

**Output example:**
```
=== Koharu Setup ===

[1/4] Checking CUDA & cuDNN...
  Found CUDA v12.9
  Found cuDNN: C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9
  cuDNN is correctly in PATH

[2/4] Checking Python & huggingface_hub...
  Found: Python 3.12.10
  huggingface_hub ready

[3/4] Downloading PaddleOCR models (language: chinese)...
  ✓ det.onnx (84.0 MB)
  ✓ rec.onnx (80.6 MB)
  ✓ dictionary.txt (18383 characters)
  ✓ config.json

[4/4] Checking build tools...
  sccache: installed
  rustc: rustc 1.93.0
  pnpm: 8.15.4

=== Setup Complete ===
```

### 4. Build the Application

```bash
# Development build (fast, with hot reload)
pnpm tauri dev

# Production build (slower, fully optimized with CUDA)
pnpm tauri build -- --features=cuda

# Production build without installers (faster for testing)
pnpm tauri build -- --features=cuda --no-bundle
```

## Model Files

The project automatically downloads and caches three HuggingFace models, plus PaddleOCR models for text detection/recognition.

### HuggingFace Models (Auto-downloaded on first launch)
| Model | Size | Location |
|-------|------|----------|
| Comic Text Detector | 90 MB | `~/.cache/huggingface/hub/models--mayocream--comic-text-detector-onnx` |
| Manga OCR | 440 MB | `~/.cache/huggingface/hub/models--mayocream--manga-ocr-onnx` |
| LaMa Inpainter | 198 MB | `~/.cache/huggingface/hub/models--mayocream--lama-manga-onnx` |

### PaddleOCR Models (Downloaded by setup.ps1)
```
%APPDATA%/koharu/models/
├── det.onnx              (84 MB)  — Text detection
├── rec.onnx              (81 MB)  — Text recognition (Chinese/Japanese)
├── dictionary.txt        (72 KB)  — 18,383 CJK characters
└── config.json           (0.5 KB) — Model configuration
```

**To use a different language:**
```powershell
# English
scripts/download_models.ps1 english

# Or use the Python script directly
python scripts/download_models.py korean
```

**Supported languages:**
- `chinese` (covers Japanese, recommended for manga)
- `english`, `latin`, `korean`, `thai`, `greek`, `eslav`
- `arabic`, `hindi`, `tamil`, `telugu`

## Build Optimization Notes

### Fast vs. Small Binary Trade-offs

The default release build prioritizes **small binary size** with settings:
```toml
opt-level = "s"           # Small binary
lto = "thin"              # Thin LTO: ~5x faster than fat LTO
codegen-units = 4         # Parallelizable compilation
```

**Build times:**
- Development build: ~30 seconds (incremental)
- Clean release build: ~3-5 minutes (on modern CPU)
- First build: ~7-10 minutes (includes ONNX Runtime download)

### Speed Up Builds with sccache

Install and enable sccache for **dramatic rebuild speedups** (minutes → seconds on repeat builds):

```bash
# Install sccache
cargo install sccache

# Enable in .cargo/config.toml
# Uncomment: rustc-wrapper = "sccache"
```

On the next build, sccache will cache compiled artifacts and dramatically reduce recompilation time on incremental rebuilds.

### Alternative: Fast Build Profile

For quick iteration during development, use the `dev-release` profile (no LTO, faster linking):

```bash
# Must edit Cargo.toml or use:
cargo build --release --profile=dev-release
```

## Troubleshooting

### cuDNN64_9.dll Not Found

**Error:** `cudnn64_9.dll not found` when running the app

**Solution:** The cuDNN bin directory must be in your PATH.
```powershell
# Check if in PATH
$env:PATH -split ';' | Where-Object { $_ -match 'cudnn' }

# If not found, run the setup script again:
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# Or add manually:
$path = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
[System.Environment]::SetEnvironmentVariable('PATH', "$path;C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9", 'User')
```

### Build Fails: Target x86_64-pc-windows-msvc Not Found

**Solution:**
```bash
rustup target add x86_64-pc-windows-msvc
```

### Memory Errors During Build

The ONNX Runtime library is large and the linking step is memory-intensive. If you see memory errors:

```bash
# Reduce link parallelism temporarily
CARGO_BUILD_JOBS=1 pnpm tauri build -- --features=cuda
```

### GPU Not Detected

**Check:**
```bash
# Verify NVIDIA GPU driver
nvidia-smi

# Check CUDA availability
nvcc --version

# Check cuDNN
dir "C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9"
```

If GPU isn't detected at runtime, the app will fall back to CPU mode (much slower).

## Usage

1. **Launch the app** (from installer or `pnpm tauri dev`)
2. **Load manga page** — Click the image icon (top-left) to open a manga page
3. **Run detection** — Click Play next to "Detection" to detect text boxes
4. **Run OCR** — Click Play next to "OCR" to extract Japanese text
5. **Translate** — Use translation panel to translate text
6. **Render & Export** — Render translated text back onto the image

## Contributing

Before contributing, please:
1. Read [AGENTS.md](../AGENTS.md) for coding guidelines
2. Check [TODO.md](../TODO.md) for current priorities
3. Review [PIPELINE.md](../PIPELINE.md) for architecture overview
4. Ensure code builds: `pnpm tauri build -- --features=cuda`
5. Test all changes locally before submitting PR

## Development References

- **Build system**: Tauri 2.x + Cargo + pnpm
- **Backend**: Rust with ONNX Runtime + CUDA
- **Frontend**: React 19 + Next.js 15 + TypeScript + Konva (canvas rendering)
- **State management**: Zustand
- **OCR Models**: PaddleOCR v5 (160+ MB), MangaOCR (440 MB)
- **Models host**: HuggingFace

## Performance Tips

1. **Enable sccache** — Rebuild speedup: minutes → seconds
2. **Use GPU** — Inference is 10-20x faster than CPU mode
3. **Batch processing** — For multiple pages, batch OCR/translation
4. **Memory**: 8 GB RAM minimum, 16 GB recommended

## Support & Issues

- **Discord**: https://discord.gg/mHvHkxGnUY
- **GitHub Issues**: https://github.com/mayocream/koharu/issues
- **Bug Reports**: Include `rustc --version`, CUDA version, and GPU model

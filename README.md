# Koharu

LLM を使った自動漫画翻訳ツール。

Automated manga translation tool with LLM, written in **Rust**.

Koharu introduces a new workflow for manga translation, utilizing the power of LLMs to automate the process. It combines the capabilities of object detection, OCR, inpainting, and LLMs to create a seamless translation experience.

Koharu is built with Tauri and React, making it lightweight and fast. It is designed to run on desktop environments, providing a native application experience.

> [!NOTE]
> For help and support, please join our [Discord server](https://discord.gg/mHvHkxGnUY).

## CUDA

Koharu is built with CUDA support, allowing it to leverage the power of NVIDIA GPUs for faster processing.

To enable CUDA support, please ensure you have the following prerequisites met:

1. [CUDA toolkit](https://developer.nvidia.com/cuda-toolkit) and [cuDNN library](https://developer.nvidia.com/cudnn) installed.
1. `PATH` environment variable set to include the paths to the DLLs of the CUDA toolkit and cuDNN library.

    Typically, these paths are:

    - `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin`
    - `C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9`

> [!NOTE]
> CUDA 12.9 and cuDNN 9.11 are tested to work with Koharu. Other versions may work, but are not guaranteed.

## Preview

![detection](./docs/images/koharu-demo-1.png)
![translation](./docs/images/koharu-demo-2.png)

You can download the latest release from the [releases page](https://github.com/mayocream/koharu/releases/latest).

Builds are available for Windows only at the moment. Please refer to the [build instructions](#build) for more details on how to build Koharu for other platforms.

> [!NOTE]
> Koharu is still in development and may not work perfectly. Please report any issues you encounter on the [issues page](https://github.com/mayocream/koharu/issues).

> [!IMPORTANT]
> **Current Status (2025-10-04)**: This project was partially completed by the original developer. Community members have fixed detection and OCR. Translation and text rendering are still in progress. See [PIPELINE.md](./PIPELINE.md) for detailed implementation status.

## Features

The workflow of translation consists of the following steps:

- [x] Detect the text in the manga using a text detection model. ✅ **Working**
- [x] Extract the detected text using an OCR model. ✅ **Working**
- [ ] Translate the extracted text using an LLM. ⚠️ **In Progress**
- [ ] Inpaint the translated text back into the manga using an inpainting model. ⚠️ **Backend Ready, UI Missing**
- [ ] Render translated text onto inpainted image. ❌ **Not Implemented**

## Models

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector) - Detects text in manga images.
- [manga-ocr](https://github.com/kha-white/manga-ocr) - Extracts text from manga images.
- [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting) - Finetuned LaMa model for inpainting manga images.

## Build

### Prerequisites

- Bun
- Rust (1.85 or later)

### Instructions

1. Clone the repository:

   ```bash
   git clone https://github.com/mayocream/koharu.git
   cd koharu
   ```

1. Install dependencies:

   ```bash
   bun install
   ```

1. Build the application:

   ```bash
   bun tauri build
   ```

1. The built application will be available in the `target/release/bundle` directory.

### Development

```bash
bun tauri dev
```

## Project Documentation

For developers and contributors:

- **[PIPELINE.md](./PIPELINE.md)** - Complete technical documentation of the translation pipeline, current implementation status, and architecture
- **[AGENTS.md](./AGENTS.md)** - Coding guidelines and best practices for AI agents and developers working on this project
- **[TODO.md](./TODO.md)** - Development roadmap with phase-by-phase task breakdown and next steps

## Usage

### Quick Start

1. Launch the application
2. Click the image icon (top-left) to load a manga page
3. Click the chat icon (sidebar) to switch to detection mode
4. Adjust detection thresholds if needed (default 0.5 works well)
5. Click the Play button next to "Detection"
   - Red bounding boxes will appear around detected text
6. Click the Play button next to "OCR"
   - Japanese text will be extracted and displayed in the list below
7. *(Translation and inpainting features coming soon)*

### Current Limitations

- Translation is not yet implemented (see TODO.md for progress)
- Inpainting UI is missing (backend ready, waiting for frontend)
- Text rendering is not implemented
- Only works on Windows with NVIDIA GPU (CUDA required)

## Troubleshooting

### "0 blocks detected" after clicking Detection

- Try lowering the confidence threshold (e.g., 0.3-0.4)
- Ensure the manga image has clear text regions
- Check browser console (F12) for errors

### OCR button does nothing

- Make sure you ran Detection first
- Check that text blocks are detected (count > 0)
- Verify browser console for errors

### App won't launch

- Ensure CUDA 12.9 and cuDNN 9.11 are installed
- Verify PATH includes CUDA/cuDNN bin directories
- Check that HuggingFace models downloaded to `%USERPROFILE%\.cache\huggingface\hub\`

## Build Time Optimization

Full builds take 3-7 minutes due to Rust compilation and CUDA bindings. To speed up development:

```bash
# Use dev mode for rapid iteration (hot reload)
bun tauri dev

# Build without installers (faster testing)
bun tauri build -- --features=cuda --no-bundle

# Install sccache for Rust compilation caching
cargo install sccache
```

See [TODO.md](./TODO.md#build-time-optimization-notes) for detailed optimization options.

## Contributing

This is a community-maintained fork of the original koharu project. Contributions welcome!

Before contributing:
1. Read [AGENTS.md](./AGENTS.md) for coding guidelines
2. Check [TODO.md](./TODO.md) for current roadmap
3. Review [PIPELINE.md](./PIPELINE.md) to understand the architecture

Please ensure:
- Code builds and tests pass
- Documentation is updated
- No API keys or secrets are committed
- Commit messages are clear and descriptive

# Font Assets Required

## Noto Sans Regular

Download Noto Sans Regular font and place it here as `NotoSans-Regular.ttf`

### Download Link:
https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf

### PowerShell Command:
```powershell
Invoke-WebRequest -Uri "https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf" -OutFile "NotoSans-Regular.ttf"
```

### Or use curl:
```bash
curl -L -o NotoSans-Regular.ttf https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
```

The Rust code expects this file at build time via `include_bytes!("../assets/fonts/NotoSans-Regular.ttf")`

## GoNotoCJKCore (Comprehensive Unicode)

Download the comprehensive Unicode font and place it here as `GoNotoCJKCore.ttf`

### Download Link:
https://github.com/satbyy/go-noto-universal/releases/download/v7.0/GoNotoCJKCore.ttf

### PowerShell Command:
```powershell
Invoke-WebRequest -Uri "https://github.com/satbyy/go-noto-universal/releases/download/v7.0/GoNotoCJKCore.ttf" -OutFile "GoNotoCJKCore.ttf"
```

### Or use curl:
```bash
curl -L -o GoNotoCJKCore.ttf https://github.com/satbyy/go-noto-universal/releases/download/v7.0/GoNotoCJKCore.ttf
```

The Rust code expects this file at build time via `include_bytes!("../assets/fonts/GoNotoCJKCore.ttf")`

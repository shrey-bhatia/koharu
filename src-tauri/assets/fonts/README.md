# Font Asset Required

Download Noto Sans Regular font and place it here as `NotoSans-Regular.ttf`

## Download Link:
https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf

## PowerShell Command:
```powershell
Invoke-WebRequest -Uri "https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf" -OutFile "NotoSans-Regular.ttf"
```

## Or use curl:
```bash
curl -L -o NotoSans-Regular.ttf https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
```

The Rust code expects this file at build time via `include_bytes!("../assets/fonts/NotoSans-Regular.ttf")`

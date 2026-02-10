#!/usr/bin/env python3
"""
Download PP-OCRv5 models for Koharu manga translation.
Usage: python scripts/download_models.py [language]
Supported languages: chinese (default), english, latin, korean, thai, greek, eslav, arabic, hindi, tamil, telugu
"""

import os
import sys
import json
import shutil
from pathlib import Path

try:
    from huggingface_hub import hf_hub_download
except ImportError:
    print("ERROR: huggingface_hub not installed")
    print("Install with: python -m pip install huggingface_hub")
    sys.exit(1)


def download_models(language: str = "chinese"):
    """Download PaddleOCR models for a specific language."""
    
    # Language to repo path mapping
    LANGUAGE_MAP = {
        "chinese": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/chinese/rec.onnx",
            "dict": "languages/chinese/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "english": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/english/rec.onnx",
            "dict": "languages/english/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "latin": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/latin/rec.onnx",
            "dict": "languages/latin/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "korean": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/korean/rec.onnx",
            "dict": "languages/korean/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "thai": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/thai/rec.onnx",
            "dict": "languages/thai/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "greek": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/greek/rec.onnx",
            "dict": "languages/greek/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "eslav": {
            "det": "detection/v5/det.onnx",
            "rec": "languages/eslav/rec.onnx",
            "dict": "languages/eslav/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": False,
        },
        "arabic": {
            "det": "detection/v3/det.onnx",
            "rec": "languages/arabic/rec.onnx",
            "dict": "languages/arabic/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": True,
        },
        "hindi": {
            "det": "detection/v3/det.onnx",
            "rec": "languages/hindi/rec.onnx",
            "dict": "languages/hindi/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": True,
        },
        "tamil": {
            "det": "detection/v3/det.onnx",
            "rec": "languages/tamil/rec.onnx",
            "dict": "languages/tamil/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": True,
        },
        "telugu": {
            "det": "detection/v3/det.onnx",
            "rec": "languages/telugu/rec.onnx",
            "dict": "languages/telugu/dict.txt",
            "rec_shape": [1, 3, 48, 320],
            "v3": True,
        },
    }
    
    if language not in LANGUAGE_MAP:
        print(f"ERROR: Unknown language '{language}'")
        print(f"Available: {', '.join(LANGUAGE_MAP.keys())}")
        return False
    
    lang_config = LANGUAGE_MAP[language]
    model_dir = Path.home() / "AppData" / "Roaming" / "koharu" / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Downloading {language.upper()} models to: {model_dir}")
    
    try:
        # Download detection model
        print(f"  Downloading detection model...")
        det_cache = hf_hub_download("monkt/paddleocr-onnx", lang_config["det"])
        det_path = model_dir / "det.onnx"
        shutil.copy2(det_cache, det_path)
        print(f"    ✓ det.onnx ({det_path.stat().st_size / 1024 / 1024:.1f} MB)")
        
        # Download recognition model
        print(f"  Downloading recognition model...")
        rec_cache = hf_hub_download("monkt/paddleocr-onnx", lang_config["rec"])
        rec_path = model_dir / "rec.onnx"
        shutil.copy2(rec_cache, rec_path)
        print(f"    ✓ rec.onnx ({rec_path.stat().st_size / 1024 / 1024:.1f} MB)")
        
        # Download dictionary
        print(f"  Downloading dictionary...")
        dict_cache = hf_hub_download("monkt/paddleocr-onnx", lang_config["dict"])
        dict_path = model_dir / "dictionary.txt"
        shutil.copy2(dict_cache, dict_path)
        
        with open(dict_path, encoding="utf-8") as f:
            num_chars = len(f.readlines())
        print(f"    ✓ dictionary.txt ({num_chars} characters)")
        
        # Create config.json
        config = {
            "det": {
                "input_shape": [1, 3, 960, 960],
                "mean": [0.485, 0.456, 0.406],
                "std": [0.229, 0.224, 0.225],
                "postprocess": {
                    "thresh": 0.3,
                    "box_thresh": 0.6,
                    "unclip_ratio": 1.5,
                    "scaling_strategy": "original",
                },
            },
            "rec": {
                "input_shape": lang_config["rec_shape"],
                "mean": [0.5, 0.5, 0.5],
                "std": [0.5, 0.5, 0.5],
            },
            "cls": {"enabled": False, "threshold": 0.9},
        }
        
        config_path = model_dir / "config.json"
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        print(f"    ✓ config.json")
        
        print(f"\n✓ All {language} models installed successfully!")
        return True
        
    except Exception as e:
        print(f"\nERROR: Download failed: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    language = sys.argv[1] if len(sys.argv) > 1 else "chinese"
    success = download_models(language)
    sys.exit(0 if success else 1)

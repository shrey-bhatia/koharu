use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Model package structure with checksums for integrity verification
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelPackage {
    pub det_model: ModelFile,
    pub rec_model: ModelFile,
    pub cls_model: Option<ModelFile>,
    pub dictionary: ModelFile,
    pub config: ModelConfig,
    pub checksums: HashMap<String, String>, // filename -> sha256
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelFile {
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelConfig {
    pub det: DetectionConfig,
    pub rec: RecognitionConfig,
    pub cls: ClassificationConfig,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectionConfig {
    pub input_shape: [i64; 4],
    pub mean: [f32; 3],
    pub std: [f32; 3],
    pub postprocess: PostProcessConfig,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecognitionConfig {
    pub input_shape: [i64; 4],
    pub mean: [f32; 3],
    pub std: [f32; 3],
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClassificationConfig {
    pub enabled: bool,
    pub threshold: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PostProcessConfig {
    pub thresh: f32,
    pub box_thresh: f32,
    pub unclip_ratio: f32,
    pub scaling_strategy: String,
}

impl ModelPackage {
    /// Load and validate a model package from directory
    pub fn from_dir(model_dir: &Path) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let config: ModelConfig = serde_json::from_reader(
            std::fs::File::open(&config_path)
                .with_context(|| format!("Failed to open config at {:?}", config_path))?,
        )
        .with_context(|| format!("Failed to parse config at {:?}", config_path))?;

        // Check for required files
        let det_path = model_dir.join("det.onnx");
        let rec_path = model_dir.join("rec.onnx");
        let dict_path = model_dir.join("dictionary.txt");
        let cls_path = model_dir.join("cls.onnx");

        if !det_path.exists() {
            return Err(anyhow::anyhow!("Missing det.onnx in {:?}", model_dir));
        }
        if !rec_path.exists() {
            return Err(anyhow::anyhow!("Missing rec.onnx in {:?}", model_dir));
        }
        if !dict_path.exists() {
            return Err(anyhow::anyhow!("Missing dictionary.txt in {:?}", model_dir));
        }

        // Load checksums
        let checksums_path = model_dir.join("checksums.json");
        let checksums: HashMap<String, String> = if checksums_path.exists() {
            serde_json::from_reader(
                std::fs::File::open(&checksums_path)
                    .with_context(|| format!("Failed to open checksums at {:?}", checksums_path))?,
            )
            .with_context(|| format!("Failed to parse checksums at {:?}", checksums_path))?
        } else {
            // Generate checksums if not present
            Self::generate_checksums(model_dir)?
        };

        // Validate checksums
        Self::validate_checksums(model_dir, &checksums)?;

        let det_model = ModelFile {
            filename: "det.onnx".to_string(),
            size: fs::metadata(&det_path)?.len(),
        };

        let rec_model = ModelFile {
            filename: "rec.onnx".to_string(),
            size: fs::metadata(&rec_path)?.len(),
        };

        let cls_model = if cls_path.exists() && config.cls.enabled {
            Some(ModelFile {
                filename: "cls.onnx".to_string(),
                size: fs::metadata(&cls_path)?.len(),
            })
        } else {
            None
        };

        let dictionary = ModelFile {
            filename: "dictionary.txt".to_string(),
            size: fs::metadata(&dict_path)?.len(),
        };

        Ok(Self {
            det_model,
            rec_model,
            cls_model,
            dictionary,
            config,
            checksums,
        })
    }

    /// Generate SHA-256 checksums for all model files
    pub fn generate_checksums(model_dir: &Path) -> Result<HashMap<String, String>> {
        let mut checksums = HashMap::new();
        let files = [
            "det.onnx",
            "rec.onnx",
            "cls.onnx",
            "dictionary.txt",
            "config.json",
        ];

        for filename in &files {
            let filepath = model_dir.join(filename);
            if filepath.exists() {
                let content = fs::read(&filepath)?;
                let hash = Sha256::digest(&content);
                let hash_str = format!("{:x}", hash);
                checksums.insert(filename.to_string(), hash_str);
            }
        }

        Ok(checksums)
    }

    /// Validate checksums for all model files
    pub fn validate_checksums(model_dir: &Path, checksums: &HashMap<String, String>) -> Result<()> {
        for (filename, expected_hash) in checksums {
            let filepath = model_dir.join(filename);
            if filepath.exists() {
                let content = fs::read(&filepath)?;
                let actual_hash = format!("{:x}", Sha256::digest(&content));
                if &actual_hash != expected_hash {
                    return Err(anyhow::anyhow!(
                        "Checksum mismatch for {}: expected {}, got {}",
                        filename,
                        expected_hash,
                        actual_hash
                    ));
                }
            }
        }
        Ok(())
    }

    /// Save checksums to file
    pub fn save_checksums(&self, model_dir: &Path) -> Result<()> {
        let checksums_path = model_dir.join("checksums.json");
        let json = serde_json::to_string_pretty(&self.checksums)?;
        fs::write(checksums_path, json)?;
        Ok(())
    }
}

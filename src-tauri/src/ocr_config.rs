use serde::Deserialize;
use anyhow::{Context, Result};
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct DetectionConfig {
    pub input_shape: [i64; 4],
    pub mean: [f32; 3],
    pub std: [f32; 3],
    pub postprocess: PostProcessConfig,
}

#[derive(Debug, Deserialize)]
pub struct RecognitionConfig {
    pub input_shape: [i64; 4],
    pub mean: [f32; 3],
    pub std: [f32; 3],
}

#[derive(Debug, Deserialize)]
pub struct ClassificationConfig {
    pub enabled: bool,
    pub threshold: f32,
}

#[derive(Debug, Deserialize)]
pub struct PostProcessConfig {
    pub thresh: f32,
    pub box_thresh: f32,
    pub unclip_ratio: f32,
    pub scaling_strategy: String,
}

#[derive(Debug, Deserialize)]
pub struct ModelConfig {
    pub det: DetectionConfig,
    pub rec: RecognitionConfig,
    pub cls: ClassificationConfig,
}

impl ModelConfig {
    pub fn from_dir(model_dir: &Path) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let config_file = std::fs::File::open(&config_path)
            .with_context(|| format!("Failed to open config file at {:?}", config_path))?;
        
        serde_json::from_reader(config_file)
            .with_context(|| format!("Failed to parse config file at {:?}", config_path))
    }
}
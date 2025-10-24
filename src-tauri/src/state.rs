use comic_text_detector::ComicTextDetector;
use image::{DynamicImage, GrayImage};
use lama::Lama;
use tokio::sync::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use crate::ocr_pipeline::OcrPipeline;

#[derive(Clone, Serialize, Debug)]
pub struct GpuInitResult {
    pub requested_provider: String,
    pub available_providers: Vec<String>,
    pub active_provider: String,
    pub device_id: u32,
    pub device_name: Option<String>,
    pub success: bool,
    pub warmup_time_ms: u32,
}

#[derive(Debug)]
pub struct AppState {
    pub comic_text_detector: Mutex<ComicTextDetector>,
    pub lama: Mutex<Lama>,
    pub gpu_init_result: Mutex<GpuInitResult>,
    pub ocr_pipelines: RwLock<HashMap<String, Arc<dyn OcrPipeline + Send + Sync>>>,
    pub active_ocr: RwLock<String>,
    pub inpaint_image_cache: RwLock<Option<Arc<DynamicImage>>>,
    pub inpaint_mask_cache: RwLock<Option<Arc<GrayImage>>>,
    pub ocr_image_cache: RwLock<Option<Arc<DynamicImage>>>,
}

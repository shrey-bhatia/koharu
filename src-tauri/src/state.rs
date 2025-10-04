use comic_text_detector::ComicTextDetector;
use lama::Lama;
use manga_ocr::MangaOCR;
use tokio::sync::Mutex;
use serde::Serialize;

#[derive(Clone, Serialize, Debug)]
pub struct GpuInitResult {
    pub requested_provider: String,
    pub active_provider: String,
    pub device_id: u32,
    pub device_name: Option<String>,
    pub success: bool,
    pub warmup_time_ms: u32,
}

#[derive(Debug)]
pub struct AppState {
    pub comic_text_detector: Mutex<ComicTextDetector>,
    pub manga_ocr: Mutex<MangaOCR>,
    pub lama: Mutex<Lama>,
    pub gpu_init_result: Mutex<GpuInitResult>,
}

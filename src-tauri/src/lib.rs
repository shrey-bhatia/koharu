mod commands;
mod error;
mod state;

use comic_text_detector::ComicTextDetector;
use lama::Lama;
use manga_ocr::MangaOCR;
use tauri::{AppHandle, Manager, async_runtime::spawn};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::Mutex;
use std::fs;

use crate::{
    commands::{detection, ocr, get_system_fonts, inpaint_region, set_gpu_preference, get_gpu_devices, get_current_gpu_status},
    state::{AppState, GpuInitResult},
};

// Read GPU preference from config file
fn read_gpu_preference(app: &AppHandle) -> String {
    let app_dir = app.path().app_config_dir()
        .expect("Failed to get app config directory");

    fs::create_dir_all(&app_dir).ok();

    let config_path = app_dir.join("gpu_preference.txt");

    fs::read_to_string(&config_path)
        .unwrap_or_else(|_| "cuda".to_string())
        .trim()
        .to_string()
}

// Get GPU device name based on provider
#[cfg(feature = "cuda")]
fn get_cuda_device_name(_device_id: u32) -> Option<String> {
    use nvml_wrapper::Nvml;
    match Nvml::init() {
        Ok(nvml) => {
            match nvml.device_by_index(_device_id) {
                Ok(device) => device.name().ok(),
                Err(_) => None,
            }
        }
        Err(_) => None,
    }
}

#[cfg(not(feature = "cuda"))]
fn get_cuda_device_name(_device_id: u32) -> Option<String> {
    None
}

// Initialize models with GPU verification
async fn initialize(app: AppHandle) -> anyhow::Result<()> {
    let gpu_pref = read_gpu_preference(&app);
    let device_id = 0u32; // Default to device 0

    tracing::info!("GPU Preference: {} (device {})", gpu_pref, device_id);

    let mut init_result = GpuInitResult {
        requested_provider: gpu_pref.clone(),
        active_provider: "Unknown".to_string(),
        device_id,
        device_name: None,
        success: false,
        warmup_time_ms: 0,
    };

    // Initialize ORT with requested provider
    match gpu_pref.as_str() {
        "cuda" => {
            #[cfg(feature = "cuda")]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CUDAExecutionProvider::default()
                            .with_device_id(device_id as i32)
                            .build()
                            .error_on_failure(),
                    ])
                    .commit()?;
                init_result.active_provider = "CUDA".to_string();
                init_result.device_name = get_cuda_device_name(device_id);
                init_result.success = true;
                tracing::info!("Initialized ORT with CUDA on device {}", device_id);
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err(anyhow::anyhow!("CUDA requested but not compiled. Rebuild with --features cuda"));
            }
        }
        "directml" => {
            #[cfg(windows)]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::DirectMLExecutionProvider::default()
                            .with_device_id(device_id as i32)
                            .build(),
                    ])
                    .commit()?;
                init_result.active_provider = "DirectML".to_string();
                init_result.device_name = Some(format!("Adapter {}", device_id));
                init_result.success = true;
                tracing::info!("Initialized ORT with DirectML");
            }
            #[cfg(not(windows))]
            {
                return Err(anyhow::anyhow!("DirectML only available on Windows"));
            }
        }
        "cpu" | _ => {
            ort::init()
                .with_execution_providers([
                    ort::execution_providers::CPUExecutionProvider::default().build(),
                ])
                .commit()?;
            init_result.active_provider = "CPU".to_string();
            init_result.success = true;
            tracing::info!("Initialized ORT with CPU");
        }
    }

    // Load models
    let comic_text_detector = ComicTextDetector::new()?;
    let manga_ocr = MangaOCR::new()?;
    let mut lama = Lama::new()?;

    // Run warmup profiling
    tracing::info!("Running warmup profiling...");
    let start = std::time::Instant::now();

    // Create dummy 512x512 input for LaMa
    let dummy_image = image::DynamicImage::new_rgb8(512, 512);
    let dummy_mask = image::DynamicImage::new_luma8(512, 512);

    // Warmup inference (ignore result)
    let _ = lama.inference(&dummy_image, &dummy_mask);

    let duration = start.elapsed();
    init_result.warmup_time_ms = duration.as_millis() as u32;

    tracing::info!("Warmup completed in {}ms", init_result.warmup_time_ms);

    // Detect potential CPU fallback
    if init_result.warmup_time_ms > 1000 && gpu_pref != "cpu" {
        tracing::warn!("Warmup took {}ms - possible CPU fallback!", init_result.warmup_time_ms);
        init_result.active_provider = format!("{} (suspected CPU fallback)", init_result.active_provider);
    }

    app.manage(AppState {
        comic_text_detector: Mutex::new(comic_text_detector),
        manga_ocr: Mutex::new(manga_ocr),
        lama: Mutex::new(lama),
        gpu_init_result: Mutex::new(init_result),
    });

    app.get_webview_window("splashscreen").unwrap().close()?;
    app.get_webview_window("main").unwrap().show()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> anyhow::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // initialize the app state
            let app_handle = app.handle().clone();
            spawn({
                async move {
                    if let Err(e) = initialize(app_handle.clone()).await {
                        app_handle
                            .dialog()
                            .message(format!("Failed to initialize: {}", e))
                            .title("Error")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        std::process::exit(1);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![detection, ocr, get_system_fonts, inpaint_region, set_gpu_preference, get_gpu_devices, get_current_gpu_status])
        .run(tauri::generate_context!())?;

    Ok(())
}

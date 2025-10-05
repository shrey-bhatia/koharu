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
    commands::{detection, ocr, get_system_fonts, inpaint_region, set_gpu_preference, get_gpu_devices, get_current_gpu_status, run_gpu_stress_test, translate_with_deepl},
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

// Get list of available ORT providers
fn get_available_ort_providers() -> Vec<String> {
    // ORT doesn't expose a clean API for this yet, so we introspect based on build features
    let mut providers = vec!["CPU".to_string()];

    #[cfg(feature = "cuda")]
    {
        // CUDA is available if feature is enabled and driver is present
        if let Some(_) = get_cuda_device_name(0) {
            providers.push("CUDA".to_string());
        }
    }

    #[cfg(windows)]
    {
        // DirectML is available on Windows 10+
        providers.push("DirectML".to_string());
    }

    providers
}

// Get GPU adapter info using wgpu (works for DirectML)
fn get_wgpu_adapter_name(device_id: u32) -> Option<String> {
    use wgpu::{Instance, InstanceDescriptor, Backends};

    let instance = Instance::new(InstanceDescriptor {
        backends: Backends::all(),
        ..Default::default()
    });

    // enumerate_adapters returns Vec<Adapter>, not an iterator
    let adapters = instance.enumerate_adapters(Backends::all());

    if let Some(adapter) = adapters.get(device_id as usize) {
        let info = adapter.get_info();
        Some(format!("{} ({:?})", info.name, info.backend))
    } else {
        None
    }
}

// Initialize models with GPU verification
async fn initialize(app: AppHandle) -> anyhow::Result<()> {
    let gpu_pref = read_gpu_preference(&app);
    let device_id = 0u32; // Default to device 0

    tracing::info!("GPU Preference: {} (device {})", gpu_pref, device_id);

    // Query available providers before init
    let available_providers = get_available_ort_providers();
    tracing::info!("Available ORT providers: {:?}", available_providers);

    let mut init_result = GpuInitResult {
        requested_provider: gpu_pref.clone(),
        available_providers: available_providers.clone(),
        active_provider: "Unknown".to_string(),
        device_id,
        device_name: None,
        success: false,
        warmup_time_ms: 0,
    };

    // FAIL FAST: Verify requested provider is available before init
    match gpu_pref.as_str() {
        "cuda" => {
            #[cfg(not(feature = "cuda"))]
            {
                return Err(anyhow::anyhow!(
                    "CUDA requested but not compiled. Rebuild with --features cuda"
                ));
            }
            #[cfg(feature = "cuda")]
            {
                if !available_providers.iter().any(|p| p == "CUDA") {
                    return Err(anyhow::anyhow!(
                        "CUDA requested but not available. Check NVIDIA drivers and CUDA toolkit installation.\nAvailable providers: {:?}",
                        available_providers
                    ));
                }
            }
        }
        "directml" => {
            #[cfg(not(windows))]
            {
                return Err(anyhow::anyhow!("DirectML only available on Windows"));
            }
        }
        _ => {}
    }

    // Initialize ORT with ONLY the requested provider (no silent fallback)
    match gpu_pref.as_str() {
        "cuda" => {
            #[cfg(feature = "cuda")]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CUDAExecutionProvider::default()
                            .with_device_id(device_id as i32)
                            .build()
                            .error_on_failure(), // CRITICAL: Fail hard if CUDA unavailable
                    ])
                    .commit()?;
                init_result.active_provider = "CUDA".to_string();
                init_result.device_name = get_cuda_device_name(device_id);
                init_result.success = true;
                tracing::info!("✓ Initialized ORT with CUDA on device {}", device_id);
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
                // Use wgpu to get actual adapter name instead of generic "Adapter 0"
                init_result.device_name = get_wgpu_adapter_name(device_id);
                init_result.success = true;
                tracing::info!("✓ Initialized ORT with DirectML");
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
            tracing::info!("✓ Initialized ORT with CPU");
        }
    }

    // Load models
    let comic_text_detector = ComicTextDetector::new()?;
    let manga_ocr = MangaOCR::new()?;
    let mut lama = Lama::new()?;

    // Run warmup profiling to verify GPU is actually used
    tracing::info!("Running warmup profiling...");
    let start = std::time::Instant::now();

    // Create dummy 512x512 input for LaMa warmup
    let dummy_image = image::DynamicImage::new_rgb8(512, 512);
    let dummy_mask = image::DynamicImage::new_luma8(512, 512);

    // Warmup inference (ignore result)
    let _ = lama.inference(&dummy_image, &dummy_mask);

    let duration = start.elapsed();
    init_result.warmup_time_ms = duration.as_millis() as u32;

    tracing::info!("Warmup completed in {}ms", init_result.warmup_time_ms);

    // Detect potential CPU fallback based on warmup latency
    // Note: First run (cold start) can be slower than subsequent runs
    // CUDA: typically <500ms after warmup, but first run can be ~1000ms
    // DirectML: typically <1000ms after warmup, but first run can be ~1500ms
    let expected_max_time = match gpu_pref.as_str() {
        "cuda" => 1500,     // CUDA warmup (includes model loading)
        "directml" => 2000, // DirectML warmup (includes model loading)
        "cpu" => u32::MAX,  // CPU is expected to be slow
        _ => u32::MAX,
    };

    if init_result.warmup_time_ms > expected_max_time {
        tracing::warn!(
            "⚠️  Warmup took {}ms (expected <{}ms) - possible CPU fallback!",
            init_result.warmup_time_ms,
            expected_max_time
        );
        init_result.active_provider = format!("{} (possible CPU fallback)", init_result.active_provider);
        init_result.success = false; // Mark as failed
    } else {
        tracing::info!(
            "✓ GPU acceleration verified: {}ms warmup (expected <{}ms)",
            init_result.warmup_time_ms,
            expected_max_time
        );
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
        .invoke_handler(tauri::generate_handler![detection, ocr, get_system_fonts, inpaint_region, set_gpu_preference, get_gpu_devices, get_current_gpu_status, run_gpu_stress_test, translate_with_deepl])
        .run(tauri::generate_context!())?;

    Ok(())
}

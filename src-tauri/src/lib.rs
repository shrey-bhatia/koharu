mod accuracy;
mod commands;
mod error;
mod hot_reload;
mod model_package;
mod ocr_pipeline;
pub mod server;
mod state;
mod text_renderer;
mod vertical_text_tests;

use comic_text_detector::ComicTextDetector;
use lama::Lama;
use manga_ocr::MangaOCR;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, async_runtime::spawn};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::Mutex;
use tokio::sync::RwLock;

use crate::commands::{
    cache_inpainting_data, cache_ocr_image, clear_inpainting_cache, clear_ocr_cache, detection,
    get_current_gpu_status, get_gpu_devices, get_system_fonts, inpaint_region,
    inpaint_region_cached, ocr, ocr_cached_block, render_and_export_image, run_gpu_stress_test,
    set_active_ocr, set_gpu_preference, translate_with_deepl, translate_with_ollama,
};
use crate::ocr_pipeline::{
    DeviceConfig, MANGA_OCR_KEY, MangaOcrPipeline, OcrPipeline, PADDLE_OCR_KEY, PaddleOcrPipeline,
};
use crate::state::{AppState, GpuInitResult};
use crate::server::ServerHandle;

// Read GPU preference from config file
fn read_gpu_preference(app: &AppHandle) -> String {
    let app_dir = app
        .path()
        .app_config_dir()
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
        Ok(nvml) => match nvml.device_by_index(_device_id) {
            Ok(device) => device.name().ok(),
            Err(_) => None,
        },
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
    use wgpu::{Backends, Instance, InstanceDescriptor};

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

    // Define model directory
    let model_dir = app.path().app_data_dir()?.join("models");
    std::fs::create_dir_all(&model_dir)?;

    // Map GPU preference to DeviceConfig for OCR pipeline
    let ocr_device_config = match gpu_pref.as_str() {
        "cuda" => DeviceConfig::Cuda,
        "directml" => DeviceConfig::Cuda, // DirectML uses CUDA provider in ORT
        _ => DeviceConfig::Cpu,
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
    tracing::info!("Initializing ONNX Runtime...");
    match gpu_pref.as_str() {
        "cuda" => {
            #[cfg(feature = "cuda")]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CUDAExecutionProvider::default()
                            .with_device_id(device_id as i32)
                            .with_conv_algorithm_search(
                                ort::execution_providers::cuda::CuDNNConvAlgorithmSearch::Heuristic,
                            )
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

    // Load ComicTextDetector on a blocking thread with timeout.
    // hf_hub::api::sync::Api does HTTP HEAD requests which can hang if HuggingFace
    // is unreachable. spawn_blocking + timeout prevents this from freezing the app.
    tracing::info!("Loading ComicTextDetector model...");
    let comic_text_detector = tokio::time::timeout(
        tokio::time::Duration::from_secs(120),
        tokio::task::spawn_blocking(|| ComicTextDetector::new()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ComicTextDetector loading timed out after 120s"))?
    .map_err(|e| anyhow::anyhow!("ComicTextDetector task panicked: {}", e))??;
    tracing::info!("✓ ComicTextDetector loaded");

    // Load LaMa inpainting model (same pattern)
    tracing::info!("Loading LaMa inpainting model...");
    let mut lama = tokio::time::timeout(
        tokio::time::Duration::from_secs(120),
        tokio::task::spawn_blocking(|| Lama::new()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("LaMa loading timed out after 120s"))?
    .map_err(|e| anyhow::anyhow!("LaMa task panicked: {}", e))??;
    tracing::info!("✓ LaMa loaded");

    let mut ocr_pipelines: HashMap<String, Arc<dyn OcrPipeline + Send + Sync>> = HashMap::new();

    tracing::info!("Loading PaddleOCR pipeline from {:?}...", model_dir);
    match PaddleOcrPipeline::new(&model_dir, ocr_device_config).await {
        Ok(ocr_pipeline) => {
            ocr_pipelines.insert(
                PADDLE_OCR_KEY.to_string(),
                Arc::new(ocr_pipeline) as Arc<dyn OcrPipeline + Send + Sync>,
            );
            tracing::info!(
                "✓ OCR pipeline initialized successfully (key={})",
                PADDLE_OCR_KEY
            );
        }
        Err(e) => {
            tracing::warn!(
                "OCR pipeline initialization failed (models not available): {}",
                e
            );
            tracing::info!(
                "Application will continue without Paddle OCR. MangaOCR fallback will be used if available."
            );
        }
    }

    // Initialize MangaOCR with a timeout to prevent hanging on HuggingFace downloads
    // HuggingFace model downloads can be slow or stall - use a 30 second timeout
    tracing::info!("Loading MangaOCR model...");
    let manga_ocr_timeout = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(|| MangaOCR::new()),
    )
    .await;

    match manga_ocr_timeout {
        Ok(Ok(Ok(manga_ocr))) => {
            let manga_pipeline =
                Arc::new(MangaOcrPipeline::new(manga_ocr)) as Arc<dyn OcrPipeline + Send + Sync>;
            ocr_pipelines.insert(MANGA_OCR_KEY.to_string(), manga_pipeline);
            tracing::info!("✓ MangaOCR pipeline registered (key={})", MANGA_OCR_KEY);
        }
        Ok(Ok(Err(err))) => {
            tracing::warn!(
                "MangaOCR initialization failed (models not downloaded yet): {}",
                err
            );
            tracing::info!("MangaOCR will be unavailable until models are cached from HuggingFace");
        }
        Ok(Err(join_err)) => {
            tracing::warn!("MangaOCR initialization task panicked: {}", join_err);
        }
        Err(_timeout_err) => {
            tracing::warn!(
                "MangaOCR initialization timed out after 30s - HuggingFace download likely stalled"
            );
            tracing::info!("Start the app again after models finish downloading, or disable MangaOCR");
        }
    }

    // Run two-pass warmup profiling to verify GPU is actually used.
    // The first inference pays for CUDA JIT compilation + cuDNN algorithm selection,
    // so it's always slow. The SECOND inference reveals true GPU performance.
    tracing::info!("Running warmup profiling (2 iterations)...");
    let dummy_image = image::DynamicImage::new_rgb8(512, 512);
    let dummy_mask = image::DynamicImage::new_luma8(512, 512);

    let warmup_result = tokio::task::spawn_blocking(move || {
        // First inference: pays CUDA JIT + cuDNN autotuning cost
        let start1 = std::time::Instant::now();
        let _ = lama.inference(&dummy_image, &dummy_mask);
        let first_ms = start1.elapsed().as_millis() as u32;

        // Second inference: should be fast if GPU is working
        let start2 = std::time::Instant::now();
        let _ = lama.inference(&dummy_image, &dummy_mask);
        let second_ms = start2.elapsed().as_millis() as u32;

        (lama, first_ms, second_ms)
    })
    .await
    .map_err(|e| anyhow::anyhow!("Warmup task panicked: {}", e))?;

    let (lama_out, first_ms, second_ms) = warmup_result;
    lama = lama_out;
    init_result.warmup_time_ms = second_ms; // Report the warm (representative) timing

    tracing::info!(
        "Warmup: 1st={}ms (cold JIT), 2nd={}ms (warm)",
        first_ms,
        second_ms
    );

    // Detect CPU fallback by checking the WARM (second) inference time
    let max_warm_time = match gpu_pref.as_str() {
        "cuda" => 500,      // CUDA warm inference should be <500ms
        "directml" => 1200, // DirectML warm inference should be <1200ms
        "cpu" => u32::MAX,
        _ => u32::MAX,
    };

    if second_ms > max_warm_time {
        tracing::warn!(
            "⚠️  Warm inference took {}ms (expected <{}ms) - likely CPU fallback!",
            second_ms,
            max_warm_time
        );
        init_result.active_provider =
            format!("{} (possible CPU fallback)", init_result.active_provider);
        init_result.success = false;
    } else {
        tracing::info!(
            "✓ GPU verified: {}ms warm inference (cold start was {}ms due to JIT/autotuning)",
            second_ms,
            first_ms
        );
    }

    let default_active_key = if ocr_pipelines.contains_key(PADDLE_OCR_KEY) {
        PADDLE_OCR_KEY.to_string()
    } else if ocr_pipelines.contains_key(MANGA_OCR_KEY) {
        MANGA_OCR_KEY.to_string()
    } else {
        ocr_pipelines.keys().next().cloned().unwrap_or_default()
    };

    let available_keys: Vec<_> = ocr_pipelines.keys().cloned().collect();
    tracing::info!(
        "Available OCR engines: {:?} (default={})",
        available_keys,
        default_active_key
    );
    if default_active_key.is_empty() {
        tracing::warn!(
            "No OCR engines registered. OCR commands will return errors until models are installed."
        );
    }

    let app_state = Arc::new(AppState {
        comic_text_detector: Mutex::new(comic_text_detector),
        lama: Mutex::new(lama),
        gpu_init_result: RwLock::new(init_result),
        ocr_pipelines: RwLock::new(ocr_pipelines),
        active_ocr: RwLock::new(default_active_key),
        inpaint_image_cache: RwLock::new(None),
        inpaint_mask_cache: RwLock::new(None),
        ocr_image_cache: RwLock::new(None),
    });

    app.manage(app_state);

    // Store server handle (initially not running)
    app.manage(Mutex::new(Option::<ServerHandle>::None));

    // Transition from splash screen to main window
    tracing::info!("Initialization complete, transitioning to main window...");
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.show()?;
    } else {
        return Err(anyhow::anyhow!("Main window not found - cannot show application"));
    }

    tracing::info!("✓ Application ready");
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
                    // Catch both errors AND panics from initialization
                    let result = std::panic::AssertUnwindSafe(initialize(app_handle.clone()));
                    let result = futures::FutureExt::catch_unwind(result).await;

                    match result {
                        Ok(Ok(())) => {
                            tracing::info!("Initialization completed successfully");
                        }
                        Ok(Err(e)) => {
                            tracing::error!("Initialization failed: {}", e);
                            app_handle
                                .dialog()
                                .message(format!("Failed to initialize: {}", e))
                                .title("Initialization Error")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                            std::process::exit(1);
                        }
                        Err(panic_err) => {
                            let msg = if let Some(s) = panic_err.downcast_ref::<String>() {
                                s.clone()
                            } else if let Some(s) = panic_err.downcast_ref::<&str>() {
                                s.to_string()
                            } else {
                                "Unknown panic during initialization".to_string()
                            };
                            tracing::error!("Initialization panicked: {}", msg);
                            app_handle
                                .dialog()
                                .message(format!("Initialization crashed: {}", msg))
                                .title("Fatal Error")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                            std::process::exit(1);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detection,
            ocr,
            set_active_ocr,
            get_system_fonts,
            inpaint_region,
            cache_inpainting_data,
            inpaint_region_cached,
            clear_inpainting_cache,
            set_gpu_preference,
            get_gpu_devices,
            get_current_gpu_status,
            run_gpu_stress_test,
            translate_with_deepl,
            translate_with_ollama,
            render_and_export_image,
            cache_ocr_image,
            clear_ocr_cache,
            ocr_cached_block,
            start_extension_server,
            stop_extension_server,
            get_extension_server_status
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}

// ============================================================================
// Extension Server Tauri Commands
// ============================================================================

#[derive(serde::Serialize)]
struct ExtensionServerStatus {
    running: bool,
    port: Option<u16>,
}

#[tauri::command]
async fn start_extension_server(
    app: AppHandle,
    port: Option<u16>,
) -> error::CommandResult<ExtensionServerStatus> {
    let port = port.unwrap_or(19284);

    // Check if already running
    let server_handle = app.state::<Mutex<Option<ServerHandle>>>();
    let mut handle_guard = server_handle.lock().await;

    if let Some(ref existing) = *handle_guard {
        return Ok(ExtensionServerStatus {
            running: true,
            port: Some(existing.port()),
        });
    }

    // AppState is managed as Arc<AppState> — clone the Arc for the server
    let app_state: Arc<AppState> = Arc::clone(&*app.state::<Arc<AppState>>());

    let handle = server::start_server(app_state, port)
        .await
        .map_err(|e| error::CommandError(e))?;

    tracing::info!("[server] Extension server started on port {}", port);
    *handle_guard = Some(handle);

    Ok(ExtensionServerStatus {
        running: true,
        port: Some(port),
    })
}

#[tauri::command]
async fn stop_extension_server(
    app: AppHandle,
) -> error::CommandResult<ExtensionServerStatus> {
    let server_handle = app.state::<Mutex<Option<ServerHandle>>>();
    let mut handle_guard = server_handle.lock().await;

    if let Some(handle) = handle_guard.take() {
        handle.shutdown();
        tracing::info!("[server] Extension server stopped");
    }

    Ok(ExtensionServerStatus {
        running: false,
        port: None,
    })
}

#[tauri::command]
async fn get_extension_server_status(
    app: AppHandle,
) -> error::CommandResult<ExtensionServerStatus> {
    let server_handle = app.state::<Mutex<Option<ServerHandle>>>();
    let handle_guard = server_handle.lock().await;

    Ok(match &*handle_guard {
        Some(handle) => ExtensionServerStatus {
            running: true,
            port: Some(handle.port()),
        },
        None => ExtensionServerStatus {
            running: false,
            port: None,
        },
    })
}

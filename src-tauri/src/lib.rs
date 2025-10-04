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
    commands::{detection, inpaint, ocr, get_system_fonts, inpaint_region, set_gpu_preference},
    state::AppState,
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

// Initialize models
async fn initialize(app: AppHandle) -> anyhow::Result<()> {
    let gpu_pref = read_gpu_preference(&app);

    tracing::info!("GPU Preference: {}", gpu_pref);

    // refer: https://ort.pyke.io/perf/execution-providers#global-defaults
    match gpu_pref.as_str() {
        "cuda" => {
            #[cfg(feature = "cuda")]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CUDAExecutionProvider::default()
                            .build()
                            .error_on_failure(),
                    ])
                    .commit()?;
                tracing::info!("Initialized ORT with CUDA");
            }
            #[cfg(not(feature = "cuda"))]
            {
                tracing::warn!("CUDA requested but not available, falling back to CPU");
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CPUExecutionProvider::default().build(),
                    ])
                    .commit()?;
            }
        }
        "directml" => {
            #[cfg(windows)]
            {
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::DirectMLExecutionProvider::default()
                            .build(),
                    ])
                    .commit()?;
                tracing::info!("Initialized ORT with DirectML");
            }
            #[cfg(not(windows))]
            {
                tracing::warn!("DirectML only available on Windows, falling back to CPU");
                ort::init()
                    .with_execution_providers([
                        ort::execution_providers::CPUExecutionProvider::default().build(),
                    ])
                    .commit()?;
            }
        }
        "cpu" | _ => {
            ort::init()
                .with_execution_providers([
                    ort::execution_providers::CPUExecutionProvider::default().build(),
                ])
                .commit()?;
            tracing::info!("Initialized ORT with CPU");
        }
    }

    let comic_text_detector = ComicTextDetector::new()?;
    let manga_ocr = MangaOCR::new()?;
    let lama = Lama::new()?;

    app.manage(AppState {
        comic_text_detector: Mutex::new(comic_text_detector),
        manga_ocr: Mutex::new(manga_ocr),
        lama: Mutex::new(lama),
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
        .invoke_handler(tauri::generate_handler![detection, ocr, inpaint, get_system_fonts, inpaint_region, set_gpu_preference])
        .run(tauri::generate_context!())?;

    Ok(())
}

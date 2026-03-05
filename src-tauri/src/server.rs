// Embedded HTTP server for browser extension support
// Runs inside the Tauri app process, sharing the same AppState and loaded models.
// Endpoints:
//   GET  /health          → server status, GPU info, version
//   GET  /config          → translation provider settings
//   POST /translate-image → full pipeline: detect → OCR → translate → inpaint → render

use axum::{
    Router,
    extract::{Multipart, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;
use crate::text_renderer::{RgbColor, TextBlock, render_text_on_image};

// ============================================================================
// Server State
// ============================================================================

/// Shared state between axum handlers and the Tauri app.
/// Wraps AppState with server-specific config.
#[derive(Clone)]
pub struct ServerState {
    pub app_state: Arc<AppState>,
    pub port: u16,
}

/// Handle for controlling the running server from Tauri commands.
pub struct ServerHandle {
    shutdown_tx: watch::Sender<bool>,
    port: u16,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        tracing::info!("[server] Shutdown signal sent");
    }
}

// ============================================================================
// Request / Response types
// ============================================================================

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    gpu: String,
    version: String,
    port: u16,
    models_loaded: bool,
}

#[derive(Serialize)]
struct ConfigResponse {
    providers: Vec<String>,
    default_provider: String,
    source_lang: String,
    target_lang: String,
}

#[derive(Deserialize)]
struct TranslateQuery {
    provider: Option<String>,
    api_key: Option<String>,
    source: Option<String>,
    target: Option<String>,
    // Ollama-specific
    model: Option<String>,
    system_prompt: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

// ============================================================================
// Handlers
// ============================================================================

async fn health_handler(AxumState(state): AxumState<ServerState>) -> Json<HealthResponse> {
    let gpu_info = state.app_state.gpu_init_result.read().await;
    Json(HealthResponse {
        status: "ok".to_string(),
        gpu: gpu_info.active_provider.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        port: state.port,
        models_loaded: gpu_info.success,
    })
}

async fn config_handler(AxumState(state): AxumState<ServerState>) -> Json<ConfigResponse> {
    let ocr_pipelines = state.app_state.ocr_pipelines.read().await;
    let _available_engines: Vec<String> = ocr_pipelines.keys().cloned().collect();
    drop(ocr_pipelines);

    Json(ConfigResponse {
        providers: vec![
            "google".into(),
            "deepl-free".into(),
            "deepl-pro".into(),
            "ollama".into(),
        ],
        default_provider: "google".into(),
        source_lang: "ja".into(),
        target_lang: "en".into(),
    })
}

/// Full translation pipeline: detect → OCR → translate → inpaint → render
/// Accepts a single image via multipart upload and returns a translated PNG.
async fn translate_image_handler(
    AxumState(state): AxumState<ServerState>,
    query: Query<TranslateQuery>,
    mut multipart: Multipart,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    // 1. Extract image from multipart
    let image_bytes = extract_image_from_multipart(&mut multipart)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Failed to read image: {}", e),
                }),
            )
        })?;

    tracing::info!(
        "[server] translate-image: received {} bytes, provider={:?}",
        image_bytes.len(),
        query.provider
    );

    // 2. Decode image
    let img = image::load_from_memory(&image_bytes).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid image data: {}", e),
            }),
        )
    })?;

    let (img_width, img_height) = img.dimensions();
    tracing::info!(
        "[server] Image decoded: {}x{} pixels",
        img_width,
        img_height
    );

    // 3. Run text detection
    let detection_output = {
        let mut detector = state.app_state.comic_text_detector.lock().await;
        detector.inference(&img, 0.4, 0.3).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Detection failed: {}", e),
                }),
            )
        })?
    };

    let bboxes = &detection_output.bboxes;
    let mask_data = detection_output.segment;
    let mask_w = detection_output.mask_width;
    let mask_h = detection_output.mask_height;

    tracing::info!(
        "[server] Detection: {} text regions, mask {}x{}",
        bboxes.len(),
        mask_w,
        mask_h
    );

    if bboxes.is_empty() {
        // No text detected — return original image as PNG
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("PNG encode failed: {}", e),
                    }),
                )
            })?;

        return Ok((
            StatusCode::OK,
            [("content-type", "image/png")],
            buf,
        )
            .into_response());
    }

    // 4. OCR each detected region
    let active_ocr_key = state.app_state.active_ocr.read().await.clone();
    let ocr_pipeline = {
        let pipelines = state.app_state.ocr_pipelines.read().await;
        pipelines.get(&active_ocr_key).cloned()
    };

    let ocr_pipeline = ocr_pipeline.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("OCR pipeline '{}' not available", active_ocr_key),
            }),
        )
    })?;

    let mut ocr_texts: Vec<String> = Vec::new();
    for bbox in bboxes {
        let xmin = bbox.xmin.floor().max(0.0) as u32;
        let ymin = bbox.ymin.floor().max(0.0) as u32;
        let xmax = (bbox.xmax.ceil() as u32).min(img_width);
        let ymax = (bbox.ymax.ceil() as u32).min(img_height);

        let w = xmax.saturating_sub(xmin);
        let h = ymax.saturating_sub(ymin);
        if w == 0 || h == 0 {
            ocr_texts.push(String::new());
            continue;
        }

        let cropped = img.crop_imm(xmin, ymin, w, h);
        match ocr_pipeline.recognize_text(&cropped, &[crate::ocr_pipeline::TextRegion {
            bbox: [0.0, 0.0, w as f32, h as f32],
            confidence: 1.0,
            text: String::new(),
            angle: None,
        }]).await {
            Ok(texts) => {
                let text = texts.into_iter().next().unwrap_or_default();
                tracing::debug!("[server] OCR bbox [{},{},{},{}]: '{}'", xmin, ymin, xmax, ymax, &text);
                ocr_texts.push(text);
            }
            Err(e) => {
                tracing::warn!("[server] OCR failed for region: {}", e);
                ocr_texts.push(String::new());
            }
        }
    }

    // 5. Translate all OCR'd texts
    let provider = query.provider.as_deref().unwrap_or("google");
    let api_key = query.api_key.as_deref().unwrap_or("");
    let source_lang = query.source.as_deref().unwrap_or("ja");
    let target_lang = query.target.as_deref().unwrap_or("en");

    let mut translated_texts: Vec<String> = Vec::new();
    for text in &ocr_texts {
        if text.trim().is_empty() {
            translated_texts.push(String::new());
            continue;
        }

        let translated = translate_text(
            text,
            provider,
            api_key,
            source_lang,
            target_lang,
            query.model.as_deref(),
            query.system_prompt.as_deref(),
        )
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("[server] Translation failed: {}", e);
            text.clone() // Fall back to original text
        });

        translated_texts.push(translated);
    }

    // 6. Inpaint (remove original text)
    let full_mask = image::GrayImage::from_vec(mask_w, mask_h, mask_data).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Failed to reconstruct detection mask".into(),
            }),
        )
    })?;

    // Resize mask to match image dimensions if needed
    let full_mask = if mask_w != img_width || mask_h != img_height {
        image::imageops::resize(
            &full_mask,
            img_width,
            img_height,
            image::imageops::FilterType::Nearest,
        )
    } else {
        full_mask
    };

    let mask_dynamic = DynamicImage::ImageLuma8(full_mask);
    let inpainted = {
        let mut lama = state.app_state.lama.lock().await;
        lama.inference(&img, &mask_dynamic).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Inpainting failed: {}", e),
                }),
            )
        })?
    };

    tracing::info!("[server] Inpainting complete");

    // 7. Render translated text onto inpainted image
    let text_blocks: Vec<TextBlock> = bboxes
        .iter()
        .zip(translated_texts.iter())
        .map(|(bbox, translated)| {
            let box_width = bbox.xmax - bbox.xmin;
            let box_height = bbox.ymax - bbox.ymin;
            // Auto-size: ~1/3 of shorter dimension, clamped to reasonable range
            let auto_font_size = (box_width.min(box_height) * 0.33).clamp(10.0, 72.0);

            TextBlock {
                xmin: bbox.xmin,
                ymin: bbox.ymin,
                xmax: bbox.xmax,
                ymax: bbox.ymax,
                translated_text: if translated.is_empty() {
                    None
                } else {
                    Some(translated.clone())
                },
                font_size: Some(auto_font_size),
                text_color: Some(RgbColor { r: 0, g: 0, b: 0 }),
                background_color: None,
                manual_bg_color: None,
                manual_text_color: None,
                font_family: None,
                font_weight: None,
                font_stretch: None,
                letter_spacing: Some(0.0),
                line_height: Some(1.2),
                appearance: None,
            }
        })
        .collect();

    let rendered = render_text_on_image(inpainted, text_blocks, "lama", "Noto Sans").map_err(
        |e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Text rendering failed: {}", e),
                }),
            )
        },
    )?;

    // 8. Encode as PNG and return
    let mut png_buffer = Vec::new();
    rendered
        .write_to(
            &mut Cursor::new(&mut png_buffer),
            image::ImageFormat::Png,
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("PNG encode failed: {}", e),
                }),
            )
        })?;

    tracing::info!(
        "[server] translate-image complete: {} bytes PNG",
        png_buffer.len()
    );

    Ok((
        StatusCode::OK,
        [("content-type", "image/png")],
        png_buffer,
    )
        .into_response())
}

// ============================================================================
// Translation helper (server-side, no Tauri dependency)
// ============================================================================

async fn translate_text(
    text: &str,
    provider: &str,
    api_key: &str,
    source_lang: &str,
    target_lang: &str,
    ollama_model: Option<&str>,
    ollama_system_prompt: Option<&str>,
) -> anyhow::Result<String> {
    match provider {
        "google" => {
            let url = format!(
                "https://translation.googleapis.com/language/translate/v2?key={}",
                api_key
            );
            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .json(&serde_json::json!({
                    "q": text,
                    "source": source_lang,
                    "target": target_lang,
                    "format": "text"
                }))
                .send()
                .await?;

            let body: serde_json::Value = resp.json().await?;
            let translated = body["data"]["translations"][0]["translatedText"]
                .as_str()
                .unwrap_or(text)
                .to_string();
            Ok(translated)
        }
        "deepl-free" | "deepl-pro" => {
            let base_url = if provider == "deepl-pro" {
                "https://api.deepl.com"
            } else {
                "https://api-free.deepl.com"
            };
            let url = format!("{}/v2/translate", base_url);
            let deepl_target = if target_lang.to_lowercase() == "en" {
                "EN-US"
            } else {
                target_lang
            };

            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .header("Authorization", format!("DeepL-Auth-Key {}", api_key))
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "text": [text],
                    "target_lang": deepl_target.to_uppercase(),
                    "source_lang": source_lang.to_uppercase()
                }))
                .send()
                .await?;

            let body: serde_json::Value = resp.json().await?;
            let translated = body["translations"][0]["text"]
                .as_str()
                .unwrap_or(text)
                .to_string();
            Ok(translated)
        }
        "ollama" => {
            let model = ollama_model.unwrap_or("llama3");
            let base = "http://localhost:11434";
            let url = format!("{}/api/chat", base);

            let mut messages = Vec::new();
            if let Some(prompt) = ollama_system_prompt {
                if !prompt.trim().is_empty() {
                    messages.push(serde_json::json!({
                        "role": "system",
                        "content": prompt
                    }));
                }
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": text
            }));

            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .json(&serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "stream": false
                }))
                .send()
                .await?;

            let body: serde_json::Value = resp.json().await?;
            let translated = body["message"]["content"]
                .as_str()
                .unwrap_or(text)
                .to_string();
            Ok(translated)
        }
        _ => {
            anyhow::bail!("Unknown translation provider: {}", provider);
        }
    }
}

// ============================================================================
// Multipart helper
// ============================================================================

async fn extract_image_from_multipart(multipart: &mut Multipart) -> anyhow::Result<Vec<u8>> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!("Multipart error: {}", e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "image" {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to read field bytes: {}", e))?;
            return Ok(bytes.to_vec());
        }
    }

    anyhow::bail!("No 'image' field found in multipart upload")
}

// ============================================================================
// Server lifecycle
// ============================================================================

/// Start the embedded HTTP server on the given port.
/// Returns a ServerHandle that can be used to shut it down.
pub async fn start_server(
    app_state: Arc<AppState>,
    port: u16,
) -> anyhow::Result<ServerHandle> {
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let server_state = ServerState {
        app_state,
        port,
    };

    // Build CORS layer: allow the Firefox extension origin
    let cors = CorsLayer::new()
        .allow_origin(Any) // moz-extension:// origins vary per install — allow all from localhost
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/config", get(config_handler))
        .route("/translate-image", post(translate_image_handler))
        .layer(cors)
        .with_state(server_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("[server] Starting embedded HTTP server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Spawn server in background
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                // Wait for shutdown signal
                loop {
                    shutdown_rx.changed().await.ok();
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                tracing::info!("[server] Graceful shutdown initiated");
            })
            .await
            .ok();

        tracing::info!("[server] HTTP server stopped");
    });

    Ok(ServerHandle { shutdown_tx, port })
}

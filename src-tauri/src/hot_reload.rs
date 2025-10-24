use anyhow::Result;
use futures::future::FutureExt;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{Duration, timeout};

/// Hot-reload manager for OCR models
pub struct HotReloadManager {
    model_dir: std::path::PathBuf,
    reload_callback: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    watcher: Option<RecommendedWatcher>,
    debounce_duration: Duration,
    pending_reload: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl HotReloadManager {
    pub fn new<F>(model_dir: &Path, reload_callback: F) -> Self
    where
        F: Fn() -> Result<()> + Send + Sync + 'static,
    {
        Self {
            model_dir: model_dir.to_path_buf(),
            reload_callback: Arc::new(reload_callback),
            watcher: None,
            debounce_duration: Duration::from_millis(500), // 500ms debounce
            pending_reload: Arc::new(Mutex::new(None)),
        }
    }

    /// Start watching for file changes
    pub async fn start(&mut self) -> Result<()> {
        let model_dir = self.model_dir.clone();
        let reload_callback = Arc::clone(&self.reload_callback);
        let pending_reload = Arc::clone(&self.pending_reload);
        let debounce_duration = self.debounce_duration;

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    if Self::should_trigger_reload(&event) {
                        Self::schedule_reload(
                            Arc::clone(&reload_callback),
                            Arc::clone(&pending_reload),
                            debounce_duration,
                        );
                    }
                }
                Err(e) => log::error!("Watch error: {:?}", e),
            },
            Config::default(),
        )?;

        watcher.watch(&model_dir, RecursiveMode::NonRecursive)?;
        self.watcher = Some(watcher);

        log::info!("Started watching model directory: {:?}", model_dir);
        Ok(())
    }

    /// Stop watching
    pub fn stop(&mut self) -> Result<()> {
        if let Some(watcher) = self.watcher.take() {
            drop(watcher);
        }
        Ok(())
    }

    /// Manually trigger reload
    pub async fn reload_now(&self) -> Result<()> {
        log::info!("Manual reload triggered");
        (self.reload_callback)()
    }

    /// Check if an event should trigger a reload
    fn should_trigger_reload(event: &Event) -> bool {
        // Watch for changes to model files
        let watched_files = [
            "det.onnx",
            "rec.onnx",
            "cls.onnx",
            "dictionary.txt",
            "config.json",
        ];
        let watched_kinds = [
            notify::EventKind::Create(notify::event::CreateKind::File),
            notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Any,
            )),
        ];

        if !watched_kinds.contains(&event.kind) {
            return false;
        }

        for path in &event.paths {
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                if watched_files.contains(&filename) {
                    return true;
                }
            }
        }

        false
    }

    /// Schedule a debounced reload
    fn schedule_reload(
        reload_callback: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        pending_reload: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
        debounce_duration: Duration,
    ) {
        tokio::spawn(async move {
            // Cancel any pending reload
            if let Some(handle) = pending_reload.lock().await.take() {
                handle.abort();
            }

            // Schedule new reload after debounce
            let handle = tokio::spawn(async move {
                tokio::time::sleep(debounce_duration).await;
                match reload_callback() {
                    Ok(()) => log::info!("Model reload completed successfully"),
                    Err(e) => log::error!("Model reload failed: {:?}", e),
                }
            });

            *pending_reload.lock().await = Some(handle);
        });
    }
}

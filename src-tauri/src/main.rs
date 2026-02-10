// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> anyhow::Result<()> {
    // In release builds the console is hidden, so also log to a file for debugging.
    let log_dir = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("koharu");
    std::fs::create_dir_all(&log_dir).ok();

    let log_file = std::fs::File::create(log_dir.join("koharu.log"));

    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,koharu_lib=debug"));

    match log_file {
        Ok(file) => {
            // Log to both stderr (visible in dev) AND a file (visible in release)
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt::layer().with_writer(std::io::stderr).with_ansi(true))
                .with(
                    fmt::layer()
                        .with_writer(std::sync::Mutex::new(file))
                        .with_ansi(false),
                )
                .init();
        }
        Err(_) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .init();
        }
    }

    tracing::info!("Koharu starting up, log file: {}", log_dir.join("koharu.log").display());

    koharu_lib::run()
}

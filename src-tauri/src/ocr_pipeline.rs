use anyhow::{Context, Result};
use image::DynamicImage;
use ort::{execution_providers::ExecutionProvider, session::Session, environment::Environment, value::Value};
use crate::model_package::ModelPackage;
use crate::accuracy::AccuracyMetrics;
use std::sync::Arc;
use std::path::Path;
use tokio::sync::Mutex;
use ndarray::Array4;

#[derive(Debug, Clone)]
pub struct TextRegion {
    pub bbox: [f32; 4], // x1, y1, x2, y2
    pub confidence: f32,
    pub text: String,
    pub angle: Option<f32>,
}

#[derive(Debug, Clone, Copy)]
pub enum DeviceConfig {
    Cpu,
    Cuda,
}

pub struct PaddleOcrPipeline {
    det_session: Arc<Mutex<Session>>,
    rec_session: Arc<Mutex<Session>>,
    cls_session: Option<Arc<Mutex<Session>>>,
    package: ModelPackage,
    dictionary: Vec<String>,
    execution_provider: String,
}

impl PaddleOcrPipeline {
    pub async fn new(model_dir: &Path, device: DeviceConfig) -> Result<Self> {
        let package = ModelPackage::from_dir(model_dir)?;
        
        let environment = Environment::builder()
            .with_name("koharu_ocr")
            .build()?;

        // Configure execution provider based on device selection
        let execution_provider = match device {
            DeviceConfig::Cuda => {
                // Check if CUDA is available (simplified check)
                #[cfg(feature = "cuda")]
                {
                    "CUDA".to_string()
                }
                #[cfg(not(feature = "cuda"))]
                {
                    log::warn!("CUDA requested but not compiled in. Falling back to CPU.");
                    "CPU".to_string()
                }
            }
            DeviceConfig::Cpu => "CPU".to_string(),
        };

        // Create session builders with execution provider
        let mut det_builder = environment.new_session_builder()?;
        let mut rec_builder = environment.new_session_builder()?;
        let mut cls_builder = environment.new_session_builder()?;

        if execution_provider == "CUDA" {
            det_builder = det_builder.with_execution_providers([ExecutionProvider::cuda()?])?;
            rec_builder = rec_builder.with_execution_providers([ExecutionProvider::cuda()?])?;
            cls_builder = cls_builder.with_execution_providers([ExecutionProvider::cuda()?])?;
        }

        // Load detection model
        let det_session = det_builder
            .with_model_from_file(model_dir.join("det.onnx"))?;

        // Load recognition model
        let rec_session = rec_builder
            .with_model_from_file(model_dir.join("rec.onnx"))?;

        // Load classification model if enabled
        let cls_session = if package.config.cls.enabled {
            Some(cls_builder.with_model_from_file(model_dir.join("cls.onnx"))?)
        } else {
            None
        };

        // Load dictionary
        let dictionary = std::fs::read_to_string(model_dir.join("dictionary.txt"))
            .context("Failed to read dictionary file")?
            .lines()
            .map(|s| s.to_string())
            .collect();

        let pipeline = Self {
            det_session: Arc::new(Mutex::new(det_session)),
            rec_session: Arc::new(Mutex::new(rec_session)),
            cls_session: cls_session.map(|s| Arc::new(Mutex::new(s))),
            package,
            dictionary,
            execution_provider,
        };

        // Log ONNX Runtime metadata
        pipeline.log_session_metadata().await;

        Ok(pipeline)
    }

    /// Log ONNX Runtime session metadata for debugging
    async fn log_session_metadata(&self) {
        log::info!("OCR Pipeline initialized with execution provider: {}", self.execution_provider);

        // Log detection session metadata
        let det_session = self.det_session.lock().await;
        Self::log_single_session_metadata("Detection", &det_session);

        // Log recognition session metadata
        let rec_session = self.rec_session.lock().await;
        Self::log_single_session_metadata("Recognition", &rec_session);

        // Log classification session metadata if available
        if let Some(cls_session) = &self.cls_session {
            let cls_session = cls_session.lock().await;
            Self::log_single_session_metadata("Classification", &cls_session);
        }
    }

    fn log_single_session_metadata(name: &str, session: &Session) {
        log::info!("{} session metadata:", name);

        // Log input metadata
        for (i, input) in session.inputs.iter().enumerate() {
            log::info!("  Input {}: {} - {:?} - {:?}",
                i, input.name, input.input_type, input.dimensions);
        }

        // Log output metadata
        for (i, output) in session.outputs.iter().enumerate() {
            log::info!("  Output {}: {} - {:?} - {:?}",
                i, output.name, output.output_type, output.dimensions);
        }
    }

    /// Detect text regions in an image
    pub async fn detect_text(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        let input_tensor = self.preprocess_detection(image)?;
        let det_session = self.det_session.lock().await;

        let outputs = det_session.run([Value::from_array(input_tensor.view())?])?;
        let output_tensor = outputs[0].try_extract_tensor::<f32>()?;
        let output_data = output_tensor.view();

        self.postprocess_detection(output_data.as_slice().unwrap())
    }

    /// Recognize text in detected regions
    pub async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<TextRegion>> {
        let mut results = Vec::new();

        for region in regions {
            let cropped = self.crop_region(image, region)?;
            let input_tensor = self.preprocess_recognition(&cropped)?;

            let rec_session = self.rec_session.lock().await;
            let outputs = rec_session.run([Value::from_array(input_tensor.view())?])?;

            let recognized_text = self.postprocess_recognition(&outputs)?;
            let mut result = region.clone();
            result.text = recognized_text;
            results.push(result);
        }

        Ok(results)
    }

    /// Run full OCR pipeline (detection + recognition + angle classification)
    pub async fn run_ocr(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        let mut regions = self.detect_text(image).await?;

        if !regions.is_empty() {
            // Apply angle classification if enabled
            self.classify_angle(&mut regions, image).await?;

            // Recognize text in regions
            regions = self.recognize_text(image, &regions).await?;
        }

        Ok(regions)
    }

    /// Calculate accuracy metrics for validation
    pub fn calculate_accuracy(&self, ground_truth: &str, predicted: &str) -> AccuracyMetrics {
        AccuracyMetrics::calculate(ground_truth, predicted)
    }

    fn preprocess_detection(&self, image: &DynamicImage) -> Result<Array4<f32>> {
        // Resize image according to config
        let resized = image.resize_exact(
            self.package.config.det.input_shape[3] as u32,
            self.package.config.det.input_shape[2] as u32,
            image::imageops::FilterType::Lanczos3
        ).to_rgb8();

        let mut tensor = Array4::zeros((
            self.package.config.det.input_shape[0] as usize,
            self.package.config.det.input_shape[1] as usize,
            self.package.config.det.input_shape[2] as usize,
            self.package.config.det.input_shape[3] as usize,
        ));

        // Normalize according to config
        for (x, y, pixel) in resized.enumerate_pixels() {
            tensor[[0, 0, y as usize, x as usize]] = (pixel[0] as f32 / 255.0 - self.package.config.det.mean[0]) / self.package.config.det.std[0];
            tensor[[0, 1, y as usize, x as usize]] = (pixel[1] as f32 / 255.0 - self.package.config.det.mean[1]) / self.package.config.det.std[1];
            tensor[[0, 2, y as usize, x as usize]] = (pixel[2] as f32 / 255.0 - self.package.config.det.mean[2]) / self.package.config.det.std[2];
        }

        Ok(tensor)
    }

    fn postprocess_detection(&self, outputs: &[f32]) -> Result<Vec<TextRegion>> {
        // DB postprocessing implementation
        // This is a simplified version - real implementation would be more complex
        let mut regions = Vec::new();

        // Placeholder: create dummy regions for now
        // In real implementation, this would parse the detection output tensor
        // and extract bounding boxes using the configured thresholds

        regions.push(TextRegion {
            bbox: [10.0, 10.0, 100.0, 30.0],
            confidence: 0.9,
            text: String::new(),
            angle: None,
        });

        Ok(regions)
    }

    async fn classify_angle(&self, regions: &mut [TextRegion], _image: &DynamicImage) -> Result<()> {
        if let Some(_cls_session) = &self.cls_session {
            // Angle classification implementation
            // This would run the classification model on each region
            // and update the angle field based on the prediction

            for region in regions.iter_mut() {
                // Placeholder: assume 0° for now
                region.angle = Some(0.0);
            }
        }
        Ok(())
    }

    fn crop_region(&self, image: &DynamicImage, region: &TextRegion) -> Result<DynamicImage> {
        let [x1, y1, x2, y2] = region.bbox;
        let width = (x2 - x1) as u32;
        let height = (y2 - y1) as u32;

        Ok(image.crop_imm(x1 as u32, y1 as u32, width, height))
    }

    fn preprocess_recognition(&self, image: &DynamicImage) -> Result<Array4<f32>> {
        let rgb = image.resize_exact(
            self.package.config.rec.input_shape[3] as u32,
            self.package.config.rec.input_shape[2] as u32,
            image::imageops::FilterType::Lanczos3
        ).to_rgb8();

        let mut tensor = Array4::zeros((
            1,
            self.package.config.rec.input_shape[1] as usize,
            self.package.config.rec.input_shape[2] as usize,
            self.package.config.rec.input_shape[3] as usize,
        ));

        for (x, y, pixel) in rgb.enumerate_pixels() {
            tensor[[0, 0, y as usize, x as usize]] = (pixel[0] as f32 / 255.0 - self.package.config.rec.mean[0]) / self.package.config.rec.std[0];
            tensor[[0, 1, y as usize, x as usize]] = (pixel[1] as f32 / 255.0 - self.package.config.rec.mean[1]) / self.package.config.rec.std[1];
            tensor[[0, 2, y as usize, x as usize]] = (pixel[2] as f32 / 255.0 - self.package.config.rec.mean[2]) / self.package.config.rec.std[2];
        }

        Ok(tensor)
    }

    fn postprocess_recognition(&self, outputs: &[Value]) -> Result<String> {
        let logits = outputs[0].try_extract_tensor::<f32>()?;
        let logits_view = logits.view();

        // CTC greedy decoding
        let mut last_idx = -1;
        let mut text = String::new();

        // Get sequence length and dictionary size
        let seq_len = logits_view.shape()[1];
        let dict_size = self.dictionary.len();

        for t in 0..seq_len {
            let mut max_val = f32::MIN;
            let mut max_idx = 0;

            for c in 0..dict_size {
                let val = logits_view[[0, t, c]];
                if val > max_val {
                    max_val = val;
                    max_idx = c;
                }
            }

            if max_idx != 0 && max_idx != last_idx as usize {
                text.push_str(&self.dictionary[max_idx]);
            }
            last_idx = max_idx as i32;
        }

        Ok(text)
    }
}

#[async_trait::async_trait]
pub trait OcrPipeline: Send + Sync {
    async fn detect_text_regions(&self, image: &DynamicImage) -> Result<Vec<TextRegion>>;
    async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<String>>;
}

#[async_trait::async_trait]
impl OcrPipeline for PaddleOcrPipeline {
    async fn detect_text_regions(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        self.detect_text(image).await
    }

    async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<String>> {
        let results = self.recognize_text(image, regions).await?;
        Ok(results.into_iter().map(|r| r.text).collect())
    }
}
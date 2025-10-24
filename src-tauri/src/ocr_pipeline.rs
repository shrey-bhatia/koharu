use anyhow::{Context, Result};
use image::{DynamicImage, GenericImageView};
use ort::{session::Session, value::Tensor};
use crate::model_package::ModelPackage;
use crate::accuracy::AccuracyMetrics;
use std::sync::Arc;
use std::path::Path;
use tokio::sync::Mutex;
use ndarray::Array4;
use manga_ocr::MangaOCR;

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

pub const PADDLE_OCR_KEY: &str = "paddle-ocr";
pub const MANGA_OCR_KEY: &str = "manga-ocr";

#[derive(Debug)]
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
        
        // Note: ORT execution provider is configured globally in lib.rs
        // Sessions will inherit the global execution provider automatically
        let execution_provider = match device {
            DeviceConfig::Cuda => "CUDA (global)",
            DeviceConfig::Cpu => "CPU (global)",
        };

        // Create session builders (inherit global execution provider)
        let det_builder = Session::builder()?;
        let rec_builder = Session::builder()?;
        let cls_builder = Session::builder()?;

        // Load detection model
        let det_session = det_builder.commit_from_file(model_dir.join("det.onnx"))?;

        // Load recognition model
        let rec_session = rec_builder.commit_from_file(model_dir.join("rec.onnx"))?;

        // Load classification model if enabled
        let cls_session = if package.config.cls.enabled {
            Some(cls_builder.commit_from_file(model_dir.join("cls.onnx"))?)
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
            execution_provider: execution_provider.to_string(),
        };

        // Log ONNX Runtime metadata
        // TODO: Move this to a separate method that can be called synchronously
        // pipeline.log_session_metadata().await;

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
            log::info!("  Input {}: {} - {:?}", i, input.name, input.input_type);
        }

        // Log output metadata
        for (i, output) in session.outputs.iter().enumerate() {
            log::info!("  Output {}: {} - {:?}", i, output.name, output.output_type);
        }
    }

    /// Detect text regions in an image
    pub async fn detect_text(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        let input_tensor = self.preprocess_detection(image)?;
        let mut det_session = self.det_session.lock().await;

        // Create ORT tensor from ndarray
        let shape = input_tensor.shape().to_vec();
        let data = input_tensor.into_raw_vec();
        let ort_tensor = Tensor::from_array((shape, data))?;

        // Run inference
        let outputs = det_session.run(ort::inputs!["x" => ort_tensor])?;
        let (_shape, output_data) = outputs["output"].try_extract_tensor::<f32>()?;

        self.postprocess_detection(output_data)
    }

    /// Recognize text in detected regions
    pub async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<TextRegion>> {
        let mut results = Vec::new();

        for region in regions {
            let cropped = self.crop_region(image, region)?;
            let input_tensor = self.preprocess_recognition(&cropped)?;

            let mut rec_session = self.rec_session.lock().await;

            // Create ORT tensor from ndarray
            let shape = input_tensor.shape().to_vec();
            let data = input_tensor.into_raw_vec();
            let ort_tensor = Tensor::from_array((shape, data))?;

            // Run inference
            let outputs = rec_session.run(ort::inputs!["x" => ort_tensor])?;
            let recognized_text = self.postprocess_recognition(&outputs["output"])?;

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

    fn postprocess_recognition(&self, output_value: &ort::value::Value) -> Result<String> {
        // Extract the output tensor
        let (_shape, output_data) = output_value.try_extract_tensor::<f32>()?;

        // This is a simplified CTC decoding implementation
        // Real implementation would decode the sequence using the character dictionary
        // and apply CTC decoding rules

        // Placeholder: return dummy text for now
        Ok("recognized_text".to_string())
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


}

    pub struct MangaOcrPipeline {
        inner: Mutex<MangaOCR>,
    }

    impl MangaOcrPipeline {
        pub fn new(instance: MangaOCR) -> Self {
            Self {
                inner: Mutex::new(instance),
            }
        }
    }

    impl std::fmt::Debug for MangaOcrPipeline {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("MangaOcrPipeline").finish_non_exhaustive()
        }
    }

#[async_trait::async_trait]
pub trait OcrPipeline: Send + Sync + std::fmt::Debug {
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

#[async_trait::async_trait]
impl OcrPipeline for MangaOcrPipeline {
    async fn detect_text_regions(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        let (width, height) = image.dimensions();
        Ok(vec![TextRegion {
            bbox: [0.0, 0.0, width as f32, height as f32],
            confidence: 1.0,
            text: String::new(),
            angle: None,
        }])
    }

    async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<String>> {
        let mut guard = self.inner.lock().await;
        // MangaOCR operates on the full image crop that caller already prepared.
        let text = guard.inference(image)?;
        Ok(regions.iter().map(|_| text.clone()).collect())
    }
}
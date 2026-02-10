use std::thread;

use candle_transformers::object_detection::{Bbox, non_maximum_suppression};
use hf_hub::api::sync::Api;
use image::GenericImageView;
use ort::{inputs, session::Session, value::TensorRef};
use serde::Serialize;

#[derive(Debug)]
pub struct ComicTextDetector {
    model: Session,
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub bboxes: Vec<ClassifiedBbox>,
    pub segment: Vec<u8>,
    pub mask_width: u32,
    pub mask_height: u32,
}

#[derive(Debug, Serialize)]
pub struct ClassifiedBbox {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
    pub confidence: f32,
    pub class: usize,
}

const MASK_THRESHOLD: u8 = 30;

impl ComicTextDetector {
    pub fn new() -> anyhow::Result<Self> {
        let api = Api::new()?;
        let repo = api.model("mayocream/comic-text-detector-onnx".to_string());
        let model_path = repo.get("comic-text-detector.onnx")?;

        let model = Session::builder()?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
            .with_intra_threads(thread::available_parallelism()?.get())?
            .commit_from_file(model_path)?;

        Ok(ComicTextDetector { model })
    }

    pub fn inference(
        &mut self,
        image: &image::DynamicImage,
        confidence_threshold: f32,
        nms_threshold: f32,
    ) -> anyhow::Result<Output> {
        debug_assert!(confidence_threshold >= 0.0 && confidence_threshold <= 1.0);
        debug_assert!(nms_threshold >= 0.0 && nms_threshold <= 1.0);
        debug_assert!(image.width() > 0 && image.height() > 0);

        let (orig_width, orig_height) = image.dimensions();
        let w_ratio = orig_width as f32 / 1024.0;
        let h_ratio = orig_height as f32 / 1024.0;
        let image = image.resize_exact(1024, 1024, image::imageops::FilterType::CatmullRom);

        let rgb_image = image.to_rgb8();
        let raw = rgb_image.as_raw();
        let input = ndarray::Array::from_shape_fn((1, 3, 1024, 1024), |(_, c, y, x)| {
            raw[(y * 1024 + x) * 3 + c] as f32 / 255.0
        });

        let inputs = inputs!["images" => TensorRef::from_array_view(input.view())?];
        let outputs = self.model.run(inputs)?;

        // handle blocks — safe access via .get() instead of Index trait which panics.
        // With panic = "abort" in release, any panic kills the whole process.
        let blk_value = outputs.get("blk").ok_or_else(|| {
            let keys: Vec<&str> = outputs.keys().collect();
            anyhow::anyhow!(
                "Detection model output 'blk' not found. Available outputs: {:?}",
                keys
            )
        })?;
        let blk = blk_value.try_extract_array::<f32>()?;
        let blk = blk.view();

        let mut boxes: Vec<Vec<Bbox<_>>> = (0..=1).map(|_| vec![]).collect();
        for i in 0..blk.shape()[1] {
            let confidence = blk[[0, i, 4]];
            if confidence < confidence_threshold {
                continue;
            }

            let mut class_index = 0;
            if blk[[0, i, 5]] < blk[[0, i, 6]] {
                class_index = 1;
            }

            let center_x = blk[[0, i, 0]] * w_ratio;
            let center_y = blk[[0, i, 1]] * h_ratio;
            let width = blk[[0, i, 2]] * w_ratio;
            let height = blk[[0, i, 3]] * h_ratio;

            boxes[class_index].push(Bbox {
                confidence,
                xmin: (center_x - width / 2.).max(0.0),
                ymin: (center_y - height / 2.).max(0.0),
                xmax: (center_x + width / 2.).min(orig_width as f32),
                ymax: (center_y + height / 2.).min(orig_height as f32),
                data: (),
            });
        }

        non_maximum_suppression(&mut boxes, nms_threshold);

        // Convert to output format
        let mut bboxes: Vec<ClassifiedBbox> = vec![];
        for (class_index, bboxes_for_class) in boxes.iter().enumerate() {
            for bbox in bboxes_for_class {
                bboxes.push(ClassifiedBbox {
                    xmin: bbox.xmin,
                    ymin: bbox.ymin,
                    xmax: bbox.xmax,
                    ymax: bbox.ymax,
                    confidence: bbox.confidence,
                    class: class_index,
                });
            }
        }

        // handle masks — safe .get() access
        let seg_value = outputs.get("seg").ok_or_else(|| {
            let keys: Vec<&str> = outputs.keys().collect();
            anyhow::anyhow!(
                "Detection model output 'seg' not found. Available outputs: {:?}",
                keys
            )
        })?;
        let mask = seg_value.try_extract_array::<f32>()?;
        let mask = mask.view();
        let mask_slice = mask.slice(ndarray::s![0, 0, .., ..]);

        // Create a new 2D array for the thresholded values
        let thresholded = mask_slice.mapv(|x| {
            let val = (255.0 * x).round() as u8;
            if val < MASK_THRESHOLD { 0 } else { val }
        });

        // Convert to Vec
        let (segment, _) = thresholded.into_raw_vec_and_offset();
        // dilate the mask
        let segment = image::GrayImage::from_vec(1024, 1024, segment)
            .ok_or_else(|| anyhow::anyhow!("Failed to create GrayImage"))?;
        let segment = imageproc::morphology::grayscale_dilate(
            &segment,
            &imageproc::morphology::Mask::square(3),
        );
        let segment =
            imageproc::morphology::erode(&segment, imageproc::distance_transform::Norm::L2, 1);
        // Resize mask to original image dimensions
        let segment = image::imageops::resize(
            &segment, orig_width, orig_height,
            image::imageops::FilterType::CatmullRom,
        );
        let mask_width = segment.width();
        let mask_height = segment.height();
        let segment = segment.into_raw();

        Ok(Output {
            bboxes,
            segment,
            mask_width,
            mask_height,
        })
    }
}

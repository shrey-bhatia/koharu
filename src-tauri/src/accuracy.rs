use unicode_segmentation::UnicodeSegmentation;

/// Character Error Rate (CER) and Word Error Rate (WER) calculation
#[derive(Debug, Clone)]
pub struct AccuracyMetrics {
    pub cer: f64,
    pub wer: f64,
}

impl AccuracyMetrics {
    /// Calculate CER and WER between ground truth and predicted text
    pub fn calculate(ground_truth: &str, predicted: &str) -> Self {
        let cer = Self::character_error_rate(ground_truth, predicted);
        let wer = Self::word_error_rate(ground_truth, predicted);

        Self { cer, wer }
    }

    /// Character Error Rate: (insertions + deletions + substitutions) / len(ground_truth)
    fn character_error_rate(ground_truth: &str, predicted: &str) -> f64 {
        let gt_chars: Vec<&str> = ground_truth.graphemes(true).collect();
        let pred_chars: Vec<&str> = predicted.graphemes(true).collect();

        if gt_chars.is_empty() {
            return if pred_chars.is_empty() { 0.0 } else { 1.0 };
        }

        let distance = Self::levenshtein_distance(&gt_chars, &pred_chars);
        distance as f64 / gt_chars.len() as f64
    }

    /// Word Error Rate: (insertions + deletions + substitutions) / word_count(ground_truth)
    fn word_error_rate(ground_truth: &str, predicted: &str) -> f64 {
        let gt_words: Vec<&str> = ground_truth.split_whitespace().collect();
        let pred_words: Vec<&str> = predicted.split_whitespace().collect();

        if gt_words.is_empty() {
            return if pred_words.is_empty() { 0.0 } else { 1.0 };
        }

        let distance = Self::levenshtein_distance(&gt_words, &pred_words);
        distance as f64 / gt_words.len() as f64
    }

    /// Levenshtein distance between two sequences
    fn levenshtein_distance<T: Eq>(a: &[T], b: &[T]) -> usize {
        let len_a = a.len();
        let len_b = b.len();

        if len_a == 0 {
            return len_b;
        }
        if len_b == 0 {
            return len_a;
        }

        let mut matrix = vec![vec![0; len_b + 1]; len_a + 1];

        // Initialize first row and column
        for i in 0..=len_a {
            matrix[i][0] = i;
        }
        for j in 0..=len_b {
            matrix[0][j] = j;
        }

        // Fill the matrix
        for i in 1..=len_a {
            for j in 1..=len_b {
                let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
                matrix[i][j] = (matrix[i - 1][j] + 1)
                    .min(matrix[i][j - 1] + 1)
                    .min(matrix[i - 1][j - 1] + cost);
            }
        }

        matrix[len_a][len_b]
    }
}

/// Batch accuracy calculation for multiple samples
#[derive(Debug, Clone)]
pub struct BatchAccuracy {
    pub samples: Vec<SampleAccuracy>,
    pub average_cer: f64,
    pub average_wer: f64,
    pub max_cer: f64,
    pub max_wer: f64,
}

#[derive(Debug, Clone)]
pub struct SampleAccuracy {
    pub ground_truth: String,
    pub predicted: String,
    pub cer: f64,
    pub wer: f64,
}

impl BatchAccuracy {
    pub fn calculate(samples: Vec<(String, String)>) -> Self {
        let mut sample_accuracies = Vec::new();
        let mut total_cer = 0.0;
        let mut total_wer = 0.0;
        let mut max_cer = 0.0f64;
        let mut max_wer = 0.0f64;

        for (ground_truth, predicted) in samples {
            let metrics = AccuracyMetrics::calculate(&ground_truth, &predicted);
            let sample = SampleAccuracy {
                ground_truth,
                predicted,
                cer: metrics.cer,
                wer: metrics.wer,
            };

            total_cer += metrics.cer;
            total_wer += metrics.wer;
            max_cer = max_cer.max(metrics.cer);
            max_wer = max_wer.max(metrics.wer);

            sample_accuracies.push(sample);
        }

        let count = sample_accuracies.len() as f64;
        let average_cer = if count > 0.0 { total_cer / count } else { 0.0 };
        let average_wer = if count > 0.0 { total_wer / count } else { 0.0 };

        Self {
            samples: sample_accuracies,
            average_cer,
            average_wer,
            max_cer,
            max_wer,
        }
    }

    /// Check if accuracy meets thresholds
    pub fn meets_thresholds(&self, max_cer: f64, max_wer: f64) -> bool {
        self.average_cer <= max_cer && self.average_wer <= max_wer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_perfect_accuracy() {
        let metrics = AccuracyMetrics::calculate("hello world", "hello world");
        assert_eq!(metrics.cer, 0.0);
        assert_eq!(metrics.wer, 0.0);
    }

    #[test]
    fn test_complete_mismatch() {
        let metrics = AccuracyMetrics::calculate("abc", "xyz");
        assert_eq!(metrics.cer, 1.0);
        assert_eq!(metrics.wer, 1.0);
    }

    #[test]
    fn test_partial_accuracy() {
        let metrics = AccuracyMetrics::calculate("hello", "hxllo");
        // "h e l l o" vs "h x l l o" - one substitution
        assert_eq!(metrics.cer, 0.2);
        assert_eq!(metrics.wer, 1.0); // Different words
    }

    #[test]
    fn test_empty_ground_truth() {
        let metrics = AccuracyMetrics::calculate("", "hello");
        assert_eq!(metrics.cer, 1.0);
        assert_eq!(metrics.wer, 1.0);
    }

    #[test]
    fn test_empty_prediction() {
        let metrics = AccuracyMetrics::calculate("hello", "");
        assert_eq!(metrics.cer, 1.0);
        assert_eq!(metrics.wer, 1.0);
    }
}

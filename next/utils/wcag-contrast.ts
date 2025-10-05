import { RGB } from './color-extraction'

/**
 * Ensure text is readable against background
 * WCAG 2.0 Level AA requires 4.5:1 contrast for normal text
 *
 * @param bgColor - Background color
 * @param textColor - Text color
 * @param minContrast - Minimum contrast ratio (default 4.5 for AA)
 * @returns Adjusted colors if needed
 */
export function ensureReadableContrast(
  bgColor: RGB,
  textColor: RGB,
  minContrast: number = 4.5
): { bgColor: RGB; textColor: RGB } {

  const currentContrast = calculateContrastRatio(bgColor, textColor)

  if (currentContrast >= minContrast) {
    // Already readable
    return { bgColor, textColor }
  }

  // Try black text
  const contrastWithBlack = calculateContrastRatio(bgColor, { r: 0, g: 0, b: 0 })

  // Try white text
  const contrastWithWhite = calculateContrastRatio(bgColor, { r: 255, g: 255, b: 255 })

  // Pick whichever gives better contrast
  const newTextColor = contrastWithBlack > contrastWithWhite
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }

  return { bgColor, textColor: newTextColor }
}

/**
 * Calculate WCAG 2.0 contrast ratio
 * Formula: (L1 + 0.05) / (L2 + 0.05)
 * where L1 is lighter, L2 is darker
 *
 * @returns Contrast ratio (1 to 21)
 */
export function calculateContrastRatio(c1: RGB, c2: RGB): number {
  const L1 = relativeLuminance(c1)
  const L2 = relativeLuminance(c2)

  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)

  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Calculate relative luminance (WCAG formula)
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 *
 * @returns Luminance value (0 to 1)
 */
export function relativeLuminance(color: RGB): number {
  // Normalize to 0-1
  const rsRGB = color.r / 255
  const gsRGB = color.g / 255
  const bsRGB = color.b / 255

  // Apply gamma correction
  const r = rsRGB <= 0.03928
    ? rsRGB / 12.92
    : Math.pow((rsRGB + 0.055) / 1.055, 2.4)

  const g = gsRGB <= 0.03928
    ? gsRGB / 12.92
    : Math.pow((gsRGB + 0.055) / 1.055, 2.4)

  const b = bsRGB <= 0.03928
    ? bsRGB / 12.92
    : Math.pow((bsRGB + 0.055) / 1.055, 2.4)

  // Calculate luminance
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Get contrast rating label (WCAG standard)
 */
export function getContrastRating(ratio: number): string {
  if (ratio >= 7.0) return 'AAA' // Enhanced contrast
  if (ratio >= 4.5) return 'AA'  // Minimum contrast
  if (ratio >= 3.0) return 'AA Large' // For large text only
  return 'Fail' // Does not meet WCAG standards
}

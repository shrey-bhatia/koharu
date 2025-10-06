import { TextBlock, MaskStats } from '@/lib/state'

/**
 * Layout Classification Module
 *
 * Analyzes text block geometry to determine optimal layout strategies.
 */

export type LayoutMode =
  | 'horizontal-standard'  // Normal horizontal text, low eccentricity
  | 'vertical-narrow'      // Tall narrow bubbles, high eccentricity
  | 'angled-slanted'       // Rotated/slanted text
  | 'caption'              // Caption blocks at panel edges

export interface LayoutStrategy {
  mode: LayoutMode
  preferredAlignment: 'center' | 'top' | 'bottom' | 'left' | 'right'
  rotationDeg?: number
  columnWidthRatio: number  // Fraction of box width to use for text column
  targetCoverageRatio: number  // Desired mask coverage (0.65-0.85)
  lineHeightMultiplier: number  // Line height as fraction of font size
  letterSpacingAdjustment: number  // Adjustment in pixels
}

/**
 * Classify a text block into a layout mode based on geometry
 */
export function classifyLayout(block: TextBlock): LayoutStrategy {
  const maskStats = block.maskStats

  if (!maskStats) {
    // Fallback: use bounding box aspect ratio
    return classifyByBoundingBox(block)
  }

  const { orientationDeg, eccentricity, area, centroid } = maskStats
  const boxWidth = block.xmax - block.xmin
  const boxHeight = block.ymax - block.ymin
  const aspectRatio = boxHeight / boxWidth
  const coverage = area / (boxWidth * boxHeight * 0.01) // Rough estimate (mask is 1024x1024)

  // Classification heuristics

  // 1. Caption blocks: Low coverage, rectangular, near edges
  if (coverage < 0.3 && aspectRatio < 1.5) {
    return {
      mode: 'caption',
      preferredAlignment: 'top',
      columnWidthRatio: 0.95,
      targetCoverageRatio: 0.75,  // Increased from 0.6 for better visual size
      lineHeightMultiplier: 1.3,
      letterSpacingAdjustment: 0,
    }
  }

  // 2. Vertical-narrow: High eccentricity + tall aspect ratio
  if (eccentricity > 3.0 && aspectRatio > 2.0) {
    return {
      mode: 'vertical-narrow',
      preferredAlignment: 'center',
      columnWidthRatio: 0.7,  // Narrow column to mimic vertical stacking
      targetCoverageRatio: 0.85,  // Increased from 0.75 for better visual size
      lineHeightMultiplier: 1.4,
      letterSpacingAdjustment: 1,
    }
  }

  // 3. Angled/slanted: Significant orientation angle
  if (Math.abs(orientationDeg) > 15 && Math.abs(orientationDeg) < 75) {
    return {
      mode: 'angled-slanted',
      preferredAlignment: determineCentroidAlignment(centroid, boxWidth, boxHeight),
      rotationDeg: orientationDeg,
      columnWidthRatio: 0.85,
      targetCoverageRatio: 0.8,  // Increased from 0.7 for better visual size
      lineHeightMultiplier: 1.2,
      letterSpacingAdjustment: 0,
    }
  }

  // 4. Horizontal standard (default)
  return {
    mode: 'horizontal-standard',
    preferredAlignment: 'center',
    columnWidthRatio: 0.9,
    targetCoverageRatio: 0.85,  // Increased from 0.75 for better visual size
    lineHeightMultiplier: 1.2,
    letterSpacingAdjustment: 0,
  }
}

/**
 * Fallback classification using bounding box aspect ratio only
 */
function classifyByBoundingBox(block: TextBlock): LayoutStrategy {
  const boxWidth = block.xmax - block.xmin
  const boxHeight = block.ymax - block.ymin
  const aspectRatio = boxHeight / boxWidth

  if (aspectRatio > 2.5) {
    // Tall and narrow
    return {
      mode: 'vertical-narrow',
      preferredAlignment: 'center',
      columnWidthRatio: 0.7,
      targetCoverageRatio: 0.75,
      lineHeightMultiplier: 1.4,
      letterSpacingAdjustment: 1,
    }
  }

  if (aspectRatio < 0.5) {
    // Wide and short (likely caption)
    return {
      mode: 'caption',
      preferredAlignment: 'top',
      columnWidthRatio: 0.95,
      targetCoverageRatio: 0.6,
      lineHeightMultiplier: 1.3,
      letterSpacingAdjustment: 0,
    }
  }

  // Default horizontal
  return {
    mode: 'horizontal-standard',
    preferredAlignment: 'center',
    columnWidthRatio: 0.9,
    targetCoverageRatio: 0.75,
    lineHeightMultiplier: 1.2,
    letterSpacingAdjustment: 0,
  }
}

/**
 * Determine alignment from centroid position relative to bounding box
 */
function determineCentroidAlignment(
  centroid: [number, number],
  boxWidth: number,
  boxHeight: number
): 'center' | 'top' | 'bottom' | 'left' | 'right' {
  const [cx, cy] = centroid
  const centerX = boxWidth / 2
  const centerY = boxHeight / 2

  const offsetX = Math.abs(cx - centerX) / boxWidth
  const offsetY = Math.abs(cy - centerY) / boxHeight

  // Vertical offset dominates
  if (offsetY > offsetX) {
    return cy < centerY ? 'top' : 'bottom'
  }

  // Horizontal offset dominates
  if (offsetX > 0.2) {
    return cx < centerX ? 'left' : 'right'
  }

  return 'center'
}

/**
 * Get a human-readable description of the layout mode
 */
export function describeLayoutMode(mode: LayoutMode): string {
  switch (mode) {
    case 'horizontal-standard':
      return 'Horizontal Standard'
    case 'vertical-narrow':
      return 'Vertical Narrow (Tall Bubble)'
    case 'angled-slanted':
      return 'Angled/Slanted'
    case 'caption':
      return 'Caption'
  }
}

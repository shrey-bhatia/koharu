export async function crop(
  image: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ImageBitmap> {
  return await createImageBitmap(image, x, y, width, height)
}

export async function resize(
  image: ImageBitmap,
  width: number,
  height: number
): Promise<ImageBitmap> {
  return await createImageBitmap(image, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  })
}

export async function imageBitmapToArrayBuffer(
  bitmap: ImageBitmap
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

export async function imageBitmapToRgbaUint8(
  bitmap: ImageBitmap
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  ctx.drawImage(bitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  return new Uint8Array(imageData.data)
}

/**
 * Convert segmentation mask (grayscale array) to PNG ArrayBuffer
 * for sending to inpainting backend
 */
export async function maskToArrayBuffer(
  mask: ArrayLike<number>,
  width = 1024,
  height = 1024
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  // Create ImageData from grayscale mask
  const imageData = new ImageData(width, height)
  for (let i = 0; i < mask.length; i++) {
    const val = mask[i] ?? 0
    imageData.data[i * 4] = val      // R
    imageData.data[i * 4 + 1] = val  // G
    imageData.data[i * 4 + 2] = val  // B
    imageData.data[i * 4 + 3] = 255  // A (fully opaque)
  }

  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

export function maskToUint8Array(mask: ArrayLike<number>): Uint8Array {
  if (mask instanceof Uint8Array) {
    return mask
  }
  return Uint8Array.from(mask)
}

interface SegmentationMaskBitmapOptions {
  targetWidth: number
  targetHeight: number
  maskWidth?: number
  maskHeight?: number
  alpha?: number
  color?: [number, number, number]
}

export async function createSegmentationMaskBitmap(
  mask: ArrayLike<number>,
  {
    targetWidth,
    targetHeight,
    maskWidth,
    maskHeight,
    alpha = 160,
    color = [255, 255, 255],
  }: SegmentationMaskBitmapOptions
): Promise<ImageBitmap> {
  if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight) || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('Invalid target dimensions for segmentation mask bitmap')
  }

  const sourceWidth = maskWidth ?? Math.round(Math.sqrt(mask.length))
  const sourceHeight = maskHeight ?? Math.round(mask.length / Math.max(sourceWidth, 1))

  if (sourceWidth * sourceHeight !== mask.length) {
    throw new Error(`Segmentation mask dimensions ${sourceWidth}x${sourceHeight} do not match data length ${mask.length}`)
  }

  const canvas = new OffscreenCanvas(sourceWidth, sourceHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context for segmentation mask')

  const imageData = ctx.createImageData(sourceWidth, sourceHeight)
  const overlayAlpha = Math.max(0, Math.min(255, Math.round(alpha)))
  const [r, g, b] = color

  for (let i = 0; i < mask.length; i++) {
    const value = mask[i] ?? 0
    const offset = i * 4
    if (value > 0) {
      imageData.data[offset] = r
      imageData.data[offset + 1] = g
      imageData.data[offset + 2] = b
      imageData.data[offset + 3] = overlayAlpha
    } else {
      imageData.data[offset] = 0
      imageData.data[offset + 1] = 0
      imageData.data[offset + 2] = 0
      imageData.data[offset + 3] = 0
    }
  }

  ctx.putImageData(imageData, 0, 0)

  let bitmap: ImageBitmap
  if (typeof canvas.transferToImageBitmap === 'function') {
    bitmap = canvas.transferToImageBitmap()
  } else {
    bitmap = await createImageBitmap(canvas)
  }

  if (bitmap.width === targetWidth && bitmap.height === targetHeight) {
    return bitmap
  }

  const resized = await createImageBitmap(bitmap, {
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: 'high',
  })

  try {
    bitmap.close()
  } catch (error) {
    console.warn('Failed to release intermediate segmentation mask bitmap:', error)
  }

  return resized
}

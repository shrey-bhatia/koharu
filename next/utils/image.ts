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

/**
 * Convert segmentation mask (grayscale array) to PNG ArrayBuffer
 * for sending to inpainting backend
 */
export async function maskToArrayBuffer(
  mask: number[],
  width = 1024,
  height = 1024
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  // Create ImageData from grayscale mask
  const imageData = new ImageData(width, height)
  for (let i = 0; i < mask.length; i++) {
    const val = mask[i]
    imageData.data[i * 4] = val      // R
    imageData.data[i * 4 + 1] = val  // G
    imageData.data[i * 4 + 2] = val  // B
    imageData.data[i * 4 + 3] = 255  // A (fully opaque)
  }

  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

import { imageDataUrl } from './http.js';

// The local demo has no external image-processing dependency. This middleware
// boundary is where a real background-removal/upscaling provider can be wired.
// For now, validated originals are stored in both fields and tagged as processed.
export function processProductImage(input) {
  const image = imageDataUrl(input, { required: true, label: 'صورة المنتج' });
  return { original: image, enhanced: image, processing: 'mock-enhanced' };
}


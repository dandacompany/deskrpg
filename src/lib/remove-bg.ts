'use client';

import { removeBackground } from '@imgly/background-removal';

/**
 * Remove background from an image (HTMLImageElement or Blob).
 * Returns a new Blob with transparent background.
 * The ONNX model runs in-browser via WebAssembly (~40MB downloaded on first use, cached after).
 */
export async function removeBg(
  input: HTMLImageElement | Blob,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  let blob: Blob;

  if (input instanceof HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = input.naturalWidth || input.width;
    canvas.height = input.naturalHeight || input.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(input, 0, 0);
    blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/png');
    });
  } else {
    blob = input;
  }

  const result = await removeBackground(blob, {
    progress: (key: string, current: number, total: number) => {
      if (onProgress && total > 0) {
        onProgress(current / total);
      }
    },
  });

  return result;
}

/**
 * Remove background and return as data URL string.
 */
export async function removeBgToDataUrl(
  input: HTMLImageElement | Blob,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const blob = await removeBg(input, onProgress);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

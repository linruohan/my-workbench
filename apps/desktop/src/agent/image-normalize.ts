/**
 * Canvas-based image normalization for vision model requests (DSH attachment-local inspired).
 * Avoids sharp; reuses the same createImageBitmap path as OCR screenshots.
 */

export type NormalizedImage = {
  dataUrl: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  /** True when re-encoded / resized from the source. */
  normalized: boolean;
};

const DEFAULT_MAX_SIDE = 2048;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const QUALITIES = [0.85, 0.75, 0.6, 0.45];

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  return Math.floor((b64.length * 3) / 4);
}

/** Downscale + JPEG re-encode so large photos fit a vision request budget. */
export async function normalizeImageForModel(
  bytes: Uint8Array,
  sourceMediaType: string,
  options?: { maxSide?: number; maxBytes?: number },
): Promise<NormalizedImage> {
  const maxSide = options?.maxSide ?? DEFAULT_MAX_SIDE;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], {
    type: sourceMediaType || "application/octet-stream",
  });
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const needsResize = scale < 1;
    const needsReencode =
      needsResize || bytes.length > maxBytes || !sourceMediaType.includes("jpeg");

    if (!needsReencode) {
      const dataUrl = `data:${sourceMediaType};base64,${uint8ToBase64(bytes)}`;
      return {
        dataUrl,
        mediaType: sourceMediaType,
        width: bitmap.width,
        height: bitmap.height,
        bytes: bytes.length,
        normalized: false,
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法规范化图片");
    context.drawImage(bitmap, 0, 0, width, height);

    let best = canvas.toDataURL("image/jpeg", QUALITIES[0]);
    for (const quality of QUALITIES) {
      const candidate = canvas.toDataURL("image/jpeg", quality);
      best = candidate;
      if (dataUrlBytes(candidate) <= maxBytes) break;
    }
    return {
      dataUrl: best,
      mediaType: "image/jpeg",
      width,
      height,
      bytes: dataUrlBytes(best),
      normalized: true,
    };
  } finally {
    bitmap.close();
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

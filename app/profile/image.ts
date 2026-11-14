/**
 * Browser-side photo resizing for /profile: center-crop to an exact size and
 * re-encode as JPEG, so only small data URLs are stored (never the original file).
 */

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface PhotoSize {
  width: number;
  height: number;
  quality: number;
}

export const AVATAR_SIZE: PhotoSize = { width: 256, height: 256, quality: 0.85 };
export const COVER_SIZE: PhotoSize = { width: 1500, height: 500, quality: 0.8 };

/** A failure with a message that is safe to show. */
export class PhotoError extends Error {}

const UNREADABLE = "We couldn't read that image. Try a JPEG or PNG.";

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall back to <img> (SVG, older Safari).
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoError(UNREADABLE);
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/** Center-crops `file` to `size` and returns a JPEG data URL. Throws PhotoError. */
export async function resizePhoto(file: File, size: PhotoSize): Promise<string> {
  if (!file.type.startsWith("image/")) throw new PhotoError("Choose an image file, like a JPEG or PNG.");
  if (file.size > MAX_PHOTO_BYTES) throw new PhotoError("That image is over 10 MB. Choose a smaller one.");
  const image = await decode(file);
  try {
    if (!image.width || !image.height) throw new PhotoError(UNREADABLE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("This browser can't resize photos.");
    ctx.fillStyle = "#fff"; // transparent PNGs get white, not black
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const scale = Math.max(size.width / image.width, size.height / image.height);
    const cropW = size.width / scale;
    const cropH = size.height / scale;
    ctx.drawImage(
      image.source,
      (image.width - cropW) / 2,
      (image.height - cropH) / 2,
      cropW,
      cropH,
      0,
      0,
      size.width,
      size.height,
    );
    const url = canvas.toDataURL("image/jpeg", size.quality);
    if (!url.startsWith("data:image/jpeg;base64,")) throw new PhotoError("This browser can't save photos.");
    return url;
  } finally {
    image.release();
  }
}

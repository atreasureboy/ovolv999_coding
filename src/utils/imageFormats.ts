export const INPUT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export const MENTION_IMAGE_TYPES: Readonly<Record<string, string>> = {
  ...INPUT_IMAGE_TYPES,
  '.bmp': 'image/bmp',
}

export function buildImageDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`
}

import { normalizePrompt } from "./promptNormalize";

const IMAGE_MARKERS = /\[Image\]|<image_files>[\s\S]*?<\/image_files>|<image_description>[\s\S]*?<\/image_description>/gi;

export function stripImageMarkers(s: string): string {
  return normalizePrompt(s.replace(IMAGE_MARKERS, " "));
}

export function hasImageMarkers(s: string): boolean {
  return /<image_files>|<image_description>|\[Image\]/i.test(s);
}

export function collisionKey(prompt: string, attachmentIds: string[] = []): string {
  return `${normalizePrompt(prompt)}\n${attachmentIds.join(",")}`;
}

export function displayUserText(raw: string, imageCount = 0): string {
  const stripped = stripImageMarkers(raw);
  if (stripped) {
    return hasImageMarkers(raw) || imageCount > 0 ? `[图片] ${stripped}` : stripped;
  }
  if (hasImageMarkers(raw) || imageCount > 0) {
    const n = imageCount > 0 ? imageCount : 1;
    return n === 1 ? "[图片]" : `[${n} 张图片]`;
  }
  return "";
}

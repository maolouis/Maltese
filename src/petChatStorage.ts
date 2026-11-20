import type { ChatMessage } from "./petChatTypes";

export const MESSAGES_KEY = "focusd-island-pet-chat-messages";
export const SESSION_KEY = "focusd-island-pet-chat-session";
export const MAX_MESSAGES = 60;
export const MAX_IMAGES = 4;
export const SEND_IMAGE_MAX_SIDE = 1280;
export const THUMB_IMAGE_MAX_SIDE = 360;

export async function fileToDataUrl(
  file: File,
  maxSide: number,
  quality: number,
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return "";
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", quality);
}

export function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadMessages(): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ChatMessage =>
        Boolean(item)
        && typeof item === "object"
        && (item as ChatMessage).role !== undefined
        && typeof (item as ChatMessage).text === "string",
      )
      .slice(-MAX_MESSAGES);
  } catch {
    return [];
  }
}

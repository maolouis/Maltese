import type { StickerId } from "./chatSticker";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  imageCount?: number;
  thumbnails?: string[];
  toolNote?: string;
  reasoning?: string;
  sticker?: StickerId;
  kind?: "text" | "sticker";
};

export type DshChatReply = { text: string; sessionId: string | null };

export type LocalChatStreamEvent = {
  requestId: string;
  kind: "delta" | "done" | "error" | "reasoning";
  text: string;
};

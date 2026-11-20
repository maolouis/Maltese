export type ClipboardHistorySettings = {
  enabled: boolean;
  captureImages: boolean;
  maxItems: number;
};

export type ClipboardHistoryImage = {
  width: number;
  height: number;
  byteSize: number;
  originalPath: string;
  thumbnailPath: string;
  thumbnailDataUrl?: string;
};

export type ClipboardHistoryItem = {
  id: string;
  kind: "text" | "image";
  hash: string;
  createdAt: number;
  copiedAt: number;
  favorite?: boolean;
  note?: string;
  preview: string;
  text?: string;
  image?: ClipboardHistoryImage;
};

export type ClipboardHistorySnapshot = {
  settings: ClipboardHistorySettings;
  items: ClipboardHistoryItem[];
};

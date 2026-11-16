import type { PetCharacterId } from "./petCharacters";

export type PetEmotion =
  | "happy"
  | "comfort"
  | "encourage"
  | "curious"
  | "surprised"
  | "sleepy"
  | "celebrate"
  | "listen";

export type PetInteractionKind =
  | "kick-ball"
  | "duo-wave"
  | "comfort"
  | "clone-wave"
  | "celebrate";

export type PetInteractionSession = {
  id: string;
  kind: PetInteractionKind;
  emotion: PetEmotion;
  primary: PetCharacterId;
  secondary: PetCharacterId;
  startedAt: number;
  durationMs: number;
};

export type ParsedPetReply = {
  text: string;
  emotion?: PetEmotion;
  interaction?: PetInteractionKind;
};

const EMOTION_ALIASES: Record<string, PetEmotion> = {
  开心: "happy",
  高兴: "happy",
  安心: "comfort",
  陪伴: "comfort",
  安慰: "comfort",
  鼓励: "encourage",
  加油: "encourage",
  好奇: "curious",
  惊讶: "surprised",
  惊喜: "surprised",
  困倦: "sleepy",
  期待: "curious",
  庆祝: "celebrate",
  倾听: "listen",
  安静: "listen",
};

const INTERACTION_ALIASES: Record<string, PetInteractionKind> = {
  踢球: "kick-ball",
  追球: "kick-ball",
  玩球: "kick-ball",
  招手: "duo-wave",
  挥手: "duo-wave",
  陪伴: "comfort",
  安慰: "comfort",
  分身: "clone-wave",
  复制: "clone-wave",
  庆祝: "celebrate",
  跳舞: "celebrate",
};

function aliasOf(value: string, aliases: Record<string, string>): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (aliases[normalized]) return aliases[normalized];
  const key = Object.keys(aliases).find((candidate) => normalized.includes(candidate));
  return key ? aliases[key] : undefined;
}

/**
 * 解析模型可选的情绪标记，并把标记从用户可见正文中移除。
 * 普通纯文本回复仍然完全兼容。
 */
export function parsePetReply(raw: string): ParsedPetReply {
  let text = raw.trim();
  const emotionMatch = text.match(/\[情绪\s*[:：]\s*([^\]]+)\]/i);
  const interactionMatch = text.match(/\[互动\s*[:：]\s*([^\]]+)\]/i);
  const emotion = emotionMatch
    ? (aliasOf(emotionMatch[1], EMOTION_ALIASES) as PetEmotion | undefined)
    : undefined;
  const interaction = interactionMatch
    ? (aliasOf(interactionMatch[1], INTERACTION_ALIASES) as PetInteractionKind | undefined)
    : undefined;
  text = text
    .replace(/\[情绪\s*[:：]\s*[^\]]+\]/gi, "")
    .replace(/\[互动\s*[:：]\s*[^\]]+\]/gi, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { text, emotion, interaction };
}

export function inferPetEmotion(text: string, kind: string): PetEmotion {
  if (/(庆祝|完成|成功|太棒|开心|哈哈)/u.test(text)) return "celebrate";
  if (/(困|累|休息|晚安|睡)/u.test(text)) return "sleepy";
  if (/(加油|可以|坚持|辛苦|别怕)/u.test(text)) return "encourage";
  if (/(陪|在这|没关系|安心|放心)/u.test(text)) return "comfort";
  if (/(怎么|什么|好奇|看看|发现)/u.test(text)) return "curious";
  if (kind === "meeting" || kind === "document") return "listen";
  if (kind === "game" || kind === "chat") return "happy";
  return "comfort";
}

export function secondaryCharacter(primary: PetCharacterId): PetCharacterId {
  if (primary === "xiaobai") return "xiaojimao";
  if (primary === "xiaojimao") return "xiaobai";
  return "duo";
}

export function createPetInteraction(input: {
  kind: PetInteractionKind;
  primary: PetCharacterId;
  emotion?: PetEmotion;
  now?: number;
  durationMs?: number;
}): PetInteractionSession {
  const now = input.now ?? Date.now();
  return {
    id: `pet-interaction-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    emotion: input.emotion ?? "happy",
    primary: input.primary,
    secondary: secondaryCharacter(input.primary),
    startedAt: now,
    durationMs: input.durationMs ?? (input.kind === "comfort" ? 3200 : 4200),
  };
}

export function interactionFromAction(action: string): PetInteractionKind | undefined {
  if (action === "chase" || action === "play") return "kick-ball";
  if (action === "celebrate" || action === "spin") return "celebrate";
  if (action === "pickup" || action === "chin") return "comfort";
  return undefined;
}

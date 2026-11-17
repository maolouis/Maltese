// 双狗互动脚本机制（台词配对 / 角色身份 / 去重 / 节拍）。
//
// 台词文案在 i18n（`petLink.scenes`），这里只放机制，方便 node --test 直接单测：
// - 一次联动 = 一对台词（小鸡毛先、小白后），两句必须来自同一组，不允许跨组拼接；
// - 最近 5 条说过的组不重复（localStorage["maltese-pet-link-history"]，只存 hash）；
// - 随从窗口没有角色身份：按 companion-* 的奇偶分配小白/小鸡毛，与主狗重复则交换。

import type { PetLinkAction } from "./petLinkBus";

export type DuoSpeaker = "xiaobai" | "xiaojimao";

export type DuoPair = {
  /** 小鸡毛那句（主动、先出）。 */
  active: string;
  /** 小白那句（回应、后出）。 */
  shy: string;
  /** 没有随从时主狗的「自说」句（A/B 剧本用）。 */
  main: string;
};

export type SceneId = "pet" | "eating" | "cheerful" | "bongo" | "standup" | "night" | "welcome";

export type SceneBank = {
  /** ≥「去重窗口 + 1」组备选（D4：窗口 5 时至少 6 组），每组是一问一答。 */
  pairs: DuoPair[];
};

export type SceneBanks = Record<SceneId, SceneBank>;

export const PET_LINK_HISTORY_KEY = "maltese-pet-link-history";
export const PET_LINK_HISTORY_LIMIT = 20;
/** 最近多少条不许重复。 */
export const PET_LINK_NO_REPEAT_WINDOW = 5;
/** 每个场景至少要准备多少组台词：去重窗口 + 1，否则「最近 N 条不重复」数学上做不到（D4）。 */
export const PET_LINK_MIN_PAIRS_PER_SCENE = PET_LINK_NO_REPEAT_WINDOW + 1;
/** 先说的先显示，两只狗错峰 ≥120ms。 */
export const PET_LINK_DUO_STAGGER_MS = 120;
/** 主狗没有随从时第二句（自我回应）的间隔。 */
export const PET_LINK_SOLO_SECOND_MS = 1200;

export function sceneIdForAction(action: PetLinkAction): SceneId {
  if (action === "pet") return "pet";
  if (action === "eating") return "eating";
  return "cheerful";
}

export function pairHash(sceneId: SceneId, index: number): string {
  return `${sceneId}:${index}`;
}

/**
 * 抽一组台词：优先最近 5 条没说过的那几组；全说过就取「最久没出现」的一组。
 * 返回 null 表示这个场景没有可用台词。
 */
export function pickPairIndex(
  pairsLength: number,
  recent: string[],
  sceneId: SceneId,
  random: () => number = Math.random,
): number | null {
  if (pairsLength <= 0) return null;
  const windowHashes = new Set(recent.slice(0, PET_LINK_NO_REPEAT_WINDOW));
  const fresh: number[] = [];
  for (let index = 0; index < pairsLength; index += 1) {
    if (!windowHashes.has(pairHash(sceneId, index))) fresh.push(index);
  }
  const pool = fresh.length > 0 ? fresh : Array.from({ length: pairsLength }, (_, index) => index);
  const picked = Math.floor(random() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, picked))];
}

/** 记录说过的组，滚动保留最近 N 条（新的在前）。 */
export function rememberPairHash(
  recent: string[],
  hash: string,
  limit: number = PET_LINK_HISTORY_LIMIT,
): string[] {
  return [hash, ...recent.filter((item) => item !== hash)].slice(0, Math.max(1, limit));
}

/** 读/写历史（只存 hash，不落聊天记录）。 */
export function loadPetLinkHistory(storage: Storage | null = safeStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PET_LINK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function savePetLinkHistory(storage: Storage | null, history: string[]): void {
  if (!storage) return;
  try {
    storage.setItem(PET_LINK_HISTORY_KEY, JSON.stringify(history.slice(0, PET_LINK_HISTORY_LIMIT)));
  } catch {
    // 隐私/配额失败不影响联动。
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export type CompanionRole = {
  speaker: DuoSpeaker;
  character: DuoSpeaker;
};

const OTHER_SPEAKER: Record<DuoSpeaker, DuoSpeaker> = {
  xiaobai: "xiaojimao",
  xiaojimao: "xiaobai",
};

/**
 * 一次联动里所有随从窗口的角色身份（纯函数）：
 * - companion-奇数 → 小白、even → 小鸡毛（偏好）；
 * - 只有一个随从时避开主狗角色，保证「主狗 + 随从」不是同一只；
 * - 有两只随从时**随从之间必须不同角色**（D3）：前一只占了偏好角色，后一只换另一只，
 *   此时主狗会自动闭嘴（buildLinkPlan 里 covered 覆盖两句），不会再出现「两只随从同句」。
 */
export function resolveCompanionRoles(labels: string[], mainCharacter: string): CompanionRole[] {
  const roles: CompanionRole[] = [];
  const taken = new Set<DuoSpeaker>();
  const mainFixed = mainCharacter === "xiaobai" || mainCharacter === "xiaojimao";
  // 主狗角色排他只在「单个随从」时成立：两个随从必须彼此不同，只能有一个与主狗重合。
  const avoidMain = mainFixed && labels.length < 2;
  const blocked = (speaker: DuoSpeaker) => taken.has(speaker) || (avoidMain && speaker === mainCharacter);
  for (const label of labels) {
    const match = /companion-(\d+)/.exec(label);
    const index = match ? Number(match[1]) : roles.length + 1;
    const preferred: DuoSpeaker = index % 2 === 1 ? "xiaobai" : "xiaojimao";
    const speaker = !blocked(preferred) ? preferred : !blocked(OTHER_SPEAKER[preferred]) ? OTHER_SPEAKER[preferred] : preferred;
    taken.add(speaker);
    roles.push({ speaker, character: speaker });
  }
  return roles;
}

/**
 * 单个随从窗口的角色身份：companion-奇数 → 小白，companion-偶数 → 小鸡毛；
 * 与主狗形象重复时交换，保证「主狗 + 随从」不是同一只。
 */
export function resolveCompanionRole(label: string, mainCharacter: string): CompanionRole {
  return resolveCompanionRoles([label], mainCharacter)[0] ?? { speaker: "xiaobai", character: "xiaobai" };
}

/** 主狗在成对台词里说哪一句：主狗是小鸡毛就说主动句，是小白就说回应句（duo 当小鸡毛）。 */
export function mainSpeakerFor(mainCharacter: string): DuoSpeaker {
  return mainCharacter === "xiaobai" ? "xiaobai" : "xiaojimao";
}

export type PlannedLine = {
  /** 谁说的：main / 随从窗口 label。 */
  who: "main" | string;
  speaker: DuoSpeaker;
  line: string;
  delayMs: number;
};

export type LinkPlan = {
  sceneId: SceneId;
  pairIndex: number;
  hash: string;
  lines: PlannedLine[];
  /** 主狗说哪一句的角色（duo 时随机取一人）。 */
  mainSpeaker: DuoSpeaker;
  /** 主狗那句（可能没有）。 */
  mainLine: string | null;
  mainDelayMs: number;
};

/**
 * 生成一次联动的完整剧本（纯函数）：
 * - 有随从：随从拿「主狗没说的那一句」，主狗拿另一句；
 * - 两个随从：一只说主动句、一只说回应句，主狗不再说；
 * - 没有随从：主狗自说第一句 +（第二句由调用方用同一组 main 派生），仍返回 mainLine。
 * 排序：小鸡毛（主动）先说、小白（回应）120ms 后说。
 */
export function buildLinkPlan(options: {
  action: PetLinkAction;
  labels: string[];
  bank: SceneBank | undefined;
  mainCharacter: string;
  recent: string[];
  random?: () => number;
  force?: boolean;
  sceneId?: SceneId;
}): LinkPlan | null {
  const { labels, bank, mainCharacter, recent, force } = options;
  const random = options.random ?? Math.random;
  if (!bank || bank.pairs.length === 0) return null;
  const sceneId = options.sceneId ?? sceneIdForAction(options.action);
  const pairIndex = force
    ? 0
    : pickPairIndex(bank.pairs.length, recent, sceneId, random);
  if (pairIndex === null) return null;
  const pair = bank.pairs[pairIndex];
  if (!pair) return null;
  const hash = pairHash(sceneId, pairIndex);

  // 随从按角色拿台词：奇数窗口=小白（回应句）、偶数窗口=小鸡毛（主动句）。
  // 两个随从时由 resolveCompanionRoles 保证彼此角色不同（D3）。
  const companionRoles = resolveCompanionRoles(labels.slice(0, 2), mainCharacter);
  const targets = labels.slice(0, 2).map((label, index) => {
    const role = companionRoles[index] ?? resolveCompanionRole(label, mainCharacter);
    const line = role.speaker === "xiaojimao" ? pair.active : pair.shy;
    return { label, speaker: role.speaker, line };
  });

  // 主狗说哪一句：优先说「随从没覆盖」的那句；两只随从都覆盖时主狗不说。
  // duo（主狗同框）没有固定身份，按台词 speaker 随机取一人，不再一律当小鸡毛。
  const covered = new Set(targets.map((target) => target.speaker));
  let mainSpeaker: DuoSpeaker;
  if (targets.length === 0) {
    // 没有随从：主狗按自己的形象说（duo 随机取一人），保证自说语气符合人设。
    mainSpeaker = mainCharacter === "duo"
      ? (random() < 0.5 ? "xiaobai" : "xiaojimao")
      : mainSpeakerFor(mainCharacter);
  } else if (!covered.has("xiaojimao")) {
    mainSpeaker = "xiaojimao";
  } else if (!covered.has("xiaobai")) {
    mainSpeaker = "xiaobai";
  } else {
    mainSpeaker = mainSpeakerFor(mainCharacter);
  }

  const lines: PlannedLine[] = [];
  let mainLine: string | null = null;
  let mainDelayMs = 0;

  if (targets.length > 0) {
    // 主狗说「随从没覆盖」的那一句；两个随从都覆盖了就不说。
    if (!covered.has(mainSpeaker)) {
      mainLine = mainSpeaker === "xiaojimao" ? pair.active : pair.shy;
      mainDelayMs = mainSpeaker === "xiaojimao" ? 0 : PET_LINK_DUO_STAGGER_MS;
    }
    for (const target of targets) {
      lines.push({
        who: target.label,
        speaker: target.speaker,
        line: target.line,
        // 小鸡毛先动（0），小白 120ms 后接。
        delayMs: target.speaker === "xiaojimao" ? 0 : PET_LINK_DUO_STAGGER_MS,
      });
    }
  } else {
    // 没有随从：主狗自说（主狗身份决定用哪句，第二句由调用方错峰补）。
    mainLine = mainSpeaker === "xiaobai" ? pair.shy : pair.active;
    mainDelayMs = 0;
  }

  return { sceneId, pairIndex, hash, lines, mainSpeaker, mainLine, mainDelayMs };
}
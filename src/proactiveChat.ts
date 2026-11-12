// 主动聊天的「观察 → 开口」逻辑。抽成独立模块，方便单独调整措辞与去重策略。
//
// 目标是让小狗像一个真的在旁边的人：先说它看到了什么（界面 / 在听的歌 / 坐了多久），
// 再给一句有情绪的回应；并且避免每天说同样的话。

export type ProactiveContext = {
  /** 前台程序类型：code / browser / video / music / chat / meeting / design / game / other */
  kind: string;
  /** 前台窗口标题（已清洗，可能为空） */
  title: string;
  /** 正在播放的媒体标题 */
  mediaTitle: string;
  /** 系统闲置秒数 */
  idleSeconds: number;
  /** 当前时间 */
  now: Date;
  /** 同一类活动已经持续的分钟数 */
  streakMinutes: number;
  /** 最近的日记事件（用户做过什么） */
  recentEvents: string[];
  /** 当前桌宠形象：xiaobai / xiaojimao / duo */
  character?: string;
};

const HISTORY_KEY = "maltese-proactive-history";
// 记录最近说过的句子、角度和时间。48 条大约能用几天，
// 再配合「按角度轮换 + 相似度判定」把重复率压下去。
const HISTORY_LIMIT = 48;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 说话的角度：换角度比换措辞更能避免「听起来都一样」。 */
export type ProactiveAngle =
  | "care"
  | "curious"
  | "clingy"
  | "tease"
  | "empathy"
  | "detail"
  | "recall"
  | "self";

const ANGLES: Array<{ id: ProactiveAngle; hint: string }> = [
  { id: "care", hint: "心疼主人累不累、身体舒不舒服" },
  { id: "curious", hint: "对主人正在做的事表示好奇" },
  { id: "clingy", hint: "撒娇、想被注意到" },
  { id: "tease", hint: "轻轻调侃、开玩笑" },
  { id: "empathy", hint: "站在主人这边，共情他的状态" },
  { id: "detail", hint: "抓住一个具体细节（时长、标题、歌名）说" },
  { id: "recall", hint: "提起刚才他做过的事" },
  { id: "self", hint: "说说小狗自己在干什么" },
];

type HistoryEntry = { text: string; at: number; kind?: string; angle?: ProactiveAngle };

function readHistoryEntries(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .map((item): HistoryEntry | null => {
        // 兼容旧版：早期只存了字符串数组。
        if (typeof item === "string") return { text: item, at: now };
        if (item && typeof item === "object") {
          const entry = item as Partial<HistoryEntry>;
          if (typeof entry.text === "string") {
            return { text: entry.text, at: entry.at ?? now, kind: entry.kind, angle: entry.angle };
          }
        }
        return null;
      })
      .filter((entry): entry is HistoryEntry => Boolean(entry))
      .filter((entry) => now - entry.at < HISTORY_MAX_AGE_MS)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeHistory(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // 忽略
  }
}

export function rememberLine(
  line: string,
  meta: { kind?: string; angle?: ProactiveAngle } = {},
) {
  const entries = readHistoryEntries();
  entries.unshift({ text: normalize(line), at: Date.now(), kind: meta.kind, angle: meta.angle });
  writeHistory(entries);
}

export function recentLines(): string[] {
  return readHistoryEntries().map((entry) => entry.text);
}

export function normalize(text: string): string {
  return text
    .replace(/[，。！？、,.!?~～…"'「」【】（）()]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 二元字组集合，用来做相似度判断（中文按字切比按词稳）。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return a === b ? 1 : 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * 和说过的话太像就算重复：
 * - 归一化后完全相同；
 * - 开头 6 个字相同（「看你又在写代码…」换后半句也算）；
 * - 二元字组相似度 ≥ 0.5（换个说法但骨架一样）。
 * 最近的几句话用更严格的 0.45，早期的话放宽到 0.6。
 */
export function isRepeated(line: string, history = recentLines()): boolean {
  const target = normalize(line);
  if (!target) return true;
  return history.some((previous, index) => {
    const candidate = normalize(previous);
    if (!candidate) return false;
    if (candidate === target) return true;
    if (target.length >= 8 && candidate.length >= 8 && candidate.slice(0, 6) === target.slice(0, 6)) {
      return true;
    }
    const threshold = index < 10 ? 0.45 : 0.6;
    return similarity(candidate, target) >= threshold;
  });
}

/** 选一个最近最少用过的角度，避免每次都是「心疼你」那一套。 */
export function pickAngle(history = readHistoryEntries()): ProactiveAngle {
  const lastUsed = new Map<ProactiveAngle, number>();
  for (const entry of history) {
    if (entry.angle && !lastUsed.has(entry.angle)) lastUsed.set(entry.angle, entry.at);
  }
  const unused = ANGLES.filter((angle) => !lastUsed.has(angle.id));
  if (unused.length > 0) {
    return unused[Math.floor(Math.random() * unused.length)].id;
  }
  const sorted = [...ANGLES].sort(
    (a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0),
  );
  // 在最早用过的三个里随机，避免完全固定顺序。
  return sorted[Math.floor(Math.random() * Math.min(3, sorted.length))].id;
}

export function angleHint(angle: ProactiveAngle): string {
  return ANGLES.find((item) => item.id === angle)?.hint ?? "";
}

/** 最近几句的开头，用来明确告诉模型「别这样起头」。 */
export function recentOpenings(limit = 6): string[] {
  return readHistoryEntries()
    .map((entry) => entry.text.slice(0, 4))
    .filter(Boolean)
    .slice(0, limit);
}
function timeBucket(now: Date): "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night" {
  const hour = now.getHours();
  if (hour < 6) return "dawn";
  if (hour < 11) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "night";
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "code":
      return "写代码";
    case "document":
      return "写文档";
    case "browser":
      return "刷网页";
    case "video":
      return "看视频";
    case "music":
      return "听音乐";
    case "chat":
      return "聊天";
    case "meeting":
      return "开会";
    case "design":
      return "做设计";
    case "game":
      return "打游戏";
    default:
      return "忙自己的事";
  }
}

/** 清洗窗口标题：去掉浏览器尾巴和多余分隔符。 */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[-–—|]\s*(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|360.*浏览器|QQ浏览器|Sogou.*浏览器)\s*$/i, "")
    .replace(/\s*[-–—|]\s*(哔哩哔哩|bilibili|抖音|douyin)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
}

function storyGuidance(character: string): string[] {
  const common =
    "参考《亲爱的小狗》的设定：小白是白色马尔济斯，小鸡毛是金黄色小金毛；两只小狗是亲密的好朋狗，在四季日常里用无声默契和无条件信任互相陪伴，把幸福落在很小的事情上。";
  switch (character) {
    case "xiaojimao":
      return [
        common,
        "当前是小鸡毛：像小太阳一样活泼、黏人、爱撒娇，偶尔贪吃和俏皮，但先用温柔的陪伴让主人放松。",
      ];
    case "duo":
      return [
        common,
        "当前是两只小狗一起：小白安静细心、略害羞，小鸡毛热情活泼；让两种气质互相接住，不抢话，也不要写成客服或旁白。",
      ];
    default:
      return [
        common,
        "当前是小白：安静、温柔、细心，带一点害羞和胆小；先观察主人的情绪，再轻声陪着说，不要突然说教。",
      ];
  }
}

export function buildPrompt(
  context: ProactiveContext,
  avoid: string[],
  angle: ProactiveAngle = "care",
): string {
  const bucket = timeBucket(context.now);
  const clock = `${context.now.getHours()}:${String(context.now.getMinutes()).padStart(2, "0")}`;
  const facts: string[] = [];
  facts.push(`现在时间：${clock}（${bucket === "dawn" ? "凌晨" : bucket === "morning" ? "上午" : bucket === "noon" ? "中午" : bucket === "afternoon" ? "下午" : bucket === "evening" ? "傍晚" : "深夜"}）`);
  facts.push(`主人正在：${kindLabel(context.kind)}${context.title ? `（窗口标题：${context.title}）` : ""}`);
  if (context.streakMinutes >= 20) {
    facts.push(`这个状态已经持续约 ${context.streakMinutes} 分钟`);
  }
  if (context.mediaTitle) facts.push(`在听的/在播的是：${context.mediaTitle}`);
  if (context.idleSeconds > 120) facts.push(`已经 ${Math.round(context.idleSeconds / 60)} 分钟没动键鼠`);
  if (context.recentEvents.length > 0) {
    facts.push(`最近做过的事：${context.recentEvents.slice(0, 3).join("；")}`);
  }

  const lines = [
    "你是住在主人电脑桌面上的线条小狗，现在主动找主人搭话。",
    ...storyGuidance(context.character ?? "xiaobai"),
    "已知信息：",
    ...facts.map((fact) => `- ${fact}`),
    "",
    "要求：",
    "1. 只说一句话，12–30 个汉字，像熟人随口开口，不要客服腔、不要「您好」「很高兴为您服务」。",
    "2. 必须结合上面的具体信息（比如具体在做什么、坐了多久、在听什么），让人感觉你真的看见了。",
    "3. 可以有情绪：心疼、撒娇、好奇、调侃都行，但要有分寸，不要说教、不要连续发问。",
    `4. 这次的角度是「${angleHint(angle)}」，只从这个角度说，别混进别的套路。`,
    "5. 不要每次都用「记得喝水」「注意休息」这种万能句。",
    "6. 不要加引号、不要加表情符号以外的格式，不要解释你为什么这么说。",
  ];
  const openings = recentOpenings(6);
  if (openings.length > 0) {
    lines.push("");
    lines.push(`不要用这些词开头：${openings.join(" / ")}`);
  }
  if (avoid.length > 0) {
    lines.push("");
    lines.push("下面这些是最近说过的话，不要重复它们的说法、句式和比喻：");
    lines.push(...avoid.slice(0, 8).map((line) => `- ${line}`));
  }
  lines.push("");
  lines.push("直接输出你要说的那一句话。");
  return lines.join("\n");
}

type FallbackRule = {
  when: (context: ProactiveContext) => boolean;
  lines: string[];
};

const FALLBACKS: FallbackRule[] = [
  {
    when: (c) => c.kind === "video" && Boolean(c.mediaTitle),
    lines: [
      "看到你在看《{media}》，这名字我惦记上了",
      "《{media}》好看吗？你笑的时候我也想凑过去",
      "{media} 看到一半啦？我先不打扰你",
    ],
  },
  {
    when: (c) => c.kind === "code",
    lines: [
      "代码写到第 {streak} 分钟了，我只在旁边趴着不吭声",
      "刚才那行报错解决了吗？我看着都替你捏把汗",
      "你敲键盘的节奏变了，是卡住了还是想通了",
    ],
  },
  {
    when: (c) => c.kind === "meeting",
    lines: ["会开这么久了，我有点想替你举手", "开会的时候别一直点头，脖子会酸", "听得累了吧，我在桌角陪着你"],
  },
  {
    when: (c) => c.kind === "chat" && c.streakMinutes >= 15,
    lines: ["聊这么久，是谁这么有意思呀", "手指都没停过，聊天很开心嘛", "我有点吃醋，也跟我说两句"],
  },
  {
    when: (c) => c.idleSeconds > 600,
    lines: ["你走开一会儿了吧，我在原地等你", "人不在也没关系，我替你看着桌子", "是不是去接水了？回来记得摸摸我"],
  },
  {
    when: (c) => c.kind === "game",
    lines: ["赢了记得跟我击个掌", "这一把我帮你加油，输了也不怪你", "打游戏的样子好专注，我偷偷看着"],
  },
  {
    when: (c) => c.kind === "music",
    lines: ["这首好听，我跟着晃脑袋了", "你在听歌，我在听你敲桌子的节奏"],
  },
  {
    when: (c) => timeBucket(c.now) === "dawn",
    lines: ["这个点还醒着，我陪你到眼皮打架", "天色都快亮了，你是有什么心事吗", "别硬撑了，我趴着陪你一会儿"],
  },
  {
    when: (c) => timeBucket(c.now) === "night",
    lines: ["夜深了，说话声音我都放轻了", "忙完这阵就收工吧，我先眯一下", "今晚的风吹得我想打盹，你也早点"],
  },
  {
    when: (c) => c.recentEvents.length > 0,
    lines: ["刚才你{event}，我记着呢", "看你{event}，感觉你今天挺认真", "你{event}的时候我在旁边看着呢"],
  },
  {
    when: () => true,
    lines: [
      "我趴这儿看了你一会儿，想知道你现在心情怎么样",
      "没什么事，就是突然想让你知道我还在",
      "桌面上有我垫着，累了就往我这边靠",
      "刚才打了个哈欠，被你忙的样子晃到了",
      "想叫你一下，又怕打断你",
    ],
  },
];

/** 每个角度一组备用句，让「关掉模型」时也不总是那几句。 */
const ANGLE_LINES: Record<ProactiveAngle, string[]> = {
  care: [
    "你坐得有点久了，我趴你手边打个滚提醒你一下",
    "肩膀是不是又耸起来了？我拿脑袋顶顶你",
    "眼睛累不累，我看屏幕都觉得晃",
  ],
  curious: [
    "你现在弄的这个，看起来挺有意思的？",
    "屏幕上那些东西是什么呀，我凑近看看",
    "这个做得挺久了，是遇到好玩的难题了吗",
  ],
  clingy: [
    "我也在这儿呢，你都不看我一眼",
    "忙归忙，抽空摸摸我嘛",
    "我尾巴都摇累了，你还没发现我",
  ],
  tease: [
    "你这么认真，我都不好意思打哈欠了",
    "又要熬夜啦？我看你是舍不得关电脑",
    "忙成这样，桌面上就我最闲",
  ],
  empathy: [
    "这事儿确实麻烦，换我也会烦",
    "不用做到完美，先把今天过完就行",
    "你已经坐了这么久，慢一点也没关系",
  ],
  detail: [
    "「{media}」这个名字我记住了，等你说说好不好看",
    "第 {streak} 分钟了，我给你记着时间呢",
    "刚才那一下你停顿了很久，是想到了什么吗",
  ],
  recall: [
    "你刚才{event}，我就在旁边看着",
    "你{event}的时候，尾巴不自觉地摇了一下",
    "想起你{event}，还怪认真的",
  ],
  self: [
    "我刚在桌角翻了个身，顺便看看你在干嘛",
    "我打了个哈欠，你也跟着困了吗",
    "我把爪子揣起来了，这样陪你比较久",
  ],
};
function fillTemplate(template: string, context: ProactiveContext): string {
  return template
    .replace("{media}", context.mediaTitle || "这个视频")
    .replace("{streak}", String(Math.max(20, Math.round(context.streakMinutes))))
    .replace("{event}", context.recentEvents[0] ?? "忙了一阵");
}

function characterFallbacks(character: string): string[] {
  switch (character) {
    case "xiaojimao":
      return [
        "我闻到你今天的忙碌啦，蹭过来陪你一下",
        "你忙得像小旋风，我先把尾巴摇给你看",
        "想吃点什么吗？我先替你馋一口",
      ];
    case "duo":
      return [
        "小白想安静陪着你，小鸡毛已经摇着尾巴凑过来了",
        "我们都在这儿，一个安静看着，一个负责把你逗笑",
        "今天的幸福先从你和我们说句话开始",
      ];
    default:
      return [
        "我先安静陪着你，想到什么慢慢说",
        "你忙你的，我把这点安静留给你",
        "看到你还在认真做事，我就安心了",
      ];
  }
}

/** 模型不可用时用：按情境 + 角度挑一句，尽量避开说过的。 */
export function pickFallback(
  context: ProactiveContext,
  history = recentLines(),
  angle: ProactiveAngle = pickAngle(),
): string {
  const matching = FALLBACKS.filter((rule) => rule.when(context));
  const pool: string[] = [];
  // 与当前角度相关的句子优先，但不独占（避免模板太少反而更容易重复）。
  const angled = ANGLE_LINES[angle] ?? [];
  pool.push(...angled.map((line) => fillTemplate(line, context)));
  for (const rule of matching) {
    for (const line of rule.lines) pool.push(fillTemplate(line, context));
  }
  pool.push(...characterFallbacks(context.character ?? "xiaobai"));

  const scored = pool.map((line, index) => ({
    line,
    index,
    repeated: isRepeated(line, history),
    // 曾经用过的次数越多，优先级越低。
    used: history.filter((previous) => normalize(previous) === normalize(line)).length,
  }));
  const fresh = scored.filter((item) => !item.repeated);
  const candidates = fresh.length > 0 ? fresh : scored;
  if (candidates.length === 0) return "我在这儿，别忙坏了";
  const leastUsed = Math.min(...candidates.map((item) => item.used));
  const best = candidates.filter((item) => item.used === leastUsed);
  return best[Math.floor(Math.random() * best.length)].line;
}
// ---------- 主动程度（0–100）----------
// 一个滑块控制四个量：冷却时间、每小时上限、状态模式的稳定时长、免打扰时段。
// 这样「主动一点/安静一点」是可解释的，而不是玄学。

export type ProactivePlan = {
  level: number;
  /** 两次主动说话至少间隔多少分钟 */
  cooldownMinutes: number;
  /** 每小时最多说几次 */
  maxPerHour: number;
  /** 跟随状态模式下，情境要稳定多少分钟才开口 */
  stabilityMinutes: number;
  /** 免打扰时段（含起点、不含终点），空数组表示不静默 */
  quietHours: [number, number] | null;
  /** 模型不可用时是否允许用备用台词（很高主动程度时才关掉，避免话变多但变生硬） */
  allowFallback: boolean;
};

const LEVEL_KEY = "maltese-proactive-level";
export const DEFAULT_PROACTIVE_LEVEL = 50;

export function loadProactiveLevel(): number {
  try {
    const raw = window.localStorage.getItem(LEVEL_KEY);
    if (!raw) return DEFAULT_PROACTIVE_LEVEL;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : DEFAULT_PROACTIVE_LEVEL;
  } catch {
    return DEFAULT_PROACTIVE_LEVEL;
  }
}

export function saveProactiveLevel(level: number) {
  const clamped = Math.min(100, Math.max(0, Math.round(level)));
  try {
    window.localStorage.setItem(LEVEL_KEY, String(clamped));
  } catch {
    // 忽略
  }
  return clamped;
}

/** 把 0–100 的主动程度换算成可执行的节奏参数。 */
export function proactivePlan(level: number): ProactivePlan {
  const value = Math.min(100, Math.max(0, Math.round(level)));
  // 冷却：100 档约 8 分钟，50 档约 1.5 小时，0 档基本不说话。
  const cooldownMinutes = Math.max(8, Math.round(240 * Math.pow(1 - value / 100, 1.4)));
  const maxPerHour = value < 20 ? 1 : value < 45 ? 2 : value < 70 ? 4 : value < 90 ? 6 : 8;
  const stabilityMinutes = value < 30 ? 6 : value < 60 ? 3 : value < 85 ? 2 : 1;
  const quietHours: [number, number] | null =
    value < 70 ? [0, 7] : value < 90 ? [1, 6] : null;
  return {
    level: value,
    cooldownMinutes,
    maxPerHour,
    stabilityMinutes,
    quietHours,
    allowFallback: true,
  };
}

/** 一句话解释当前档位，直接显示在设置里。 */
export function describeProactivePlan(plan: ProactivePlan): string {
  const quiet = plan.quietHours
    ? `，${plan.quietHours[0]}–${plan.quietHours[1]} 点不打扰`
    : "，全天都可以说话";
  return `大约每 ${plan.cooldownMinutes} 分钟最多一次，每小时不超过 ${plan.maxPerHour} 次${quiet}`;
}

const TIMES_KEY = "maltese-proactive-times";

function readSpeakTimes(): number[] {
  try {
    const raw = window.localStorage.getItem(TIMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return parsed.filter((item): item is number => typeof item === "number" && item > cutoff);
  } catch {
    return [];
  }
}

export function recordSpeakTime(at = Date.now()) {
  const times = [at, ...readSpeakTimes()].slice(0, 200);
  try {
    window.localStorage.setItem(TIMES_KEY, JSON.stringify(times));
  } catch {
    // 忽略
  }
}

/** 当前是否已经超过每小时上限。 */
export function overHourlyLimit(plan: ProactivePlan, now = Date.now()): boolean {
  const recent = readSpeakTimes().filter((time) => now - time < 60 * 60 * 1000);
  return recent.length >= plan.maxPerHour;
}

/** 当前是否落在免打扰时段。 */
export function inQuietHours(plan: ProactivePlan, now = new Date()): boolean {
  if (!plan.quietHours) return false;
  const [start, end] = plan.quietHours;
  const hour = now.getHours();
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}
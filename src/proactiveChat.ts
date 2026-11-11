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
};

const HISTORY_KEY = "maltese-proactive-history";
const HISTORY_LIMIT = 12;

function readHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rememberLine(line: string) {
  const next = [normalize(line), ...readHistory()].slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 忽略
  }
}

export function recentLines(): string[] {
  return readHistory();
}

export function normalize(text: string): string {
  return text.replace(/[\s，。！？、,.!?~～…"'「」]/g, "");
}

/** 和最近说过的话太像，就算重复。 */
export function isRepeated(line: string, history = readHistory()): boolean {
  const target = normalize(line);
  if (!target) return true;
  return history.some((previous) => {
    const candidate = normalize(previous);
    if (!candidate) return false;
    if (candidate === target) return true;
    // 前 10 个字一样也当作重复，避免「看你又在写代码」换了后半句
    return target.length >= 10 && candidate.length >= 10 && candidate.slice(0, 10) === target.slice(0, 10);
  });
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

export function buildPrompt(context: ProactiveContext, avoid: string[]): string {
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
    "已知信息：",
    ...facts.map((fact) => `- ${fact}`),
    "",
    "要求：",
    "1. 只说一句话，12–30 个汉字，像熟人随口开口，不要客服腔、不要「您好」「很高兴为您服务」。",
    "2. 必须结合上面的具体信息（比如具体在做什么、坐了多久、在听什么），让人感觉你真的看见了。",
    "3. 可以有情绪：心疼、撒娇、好奇、调侃都行，但要有分寸，不要说教、不要连续发问。",
    "4. 不要每次都用「记得喝水」「注意休息」这种万能句；换着角度说。",
    "5. 不要加引号、不要加表情符号以外的格式，不要解释你为什么这么说。",
  ];
  if (avoid.length > 0) {
    lines.push("");
    lines.push("下面这些是最近说过的话，不要重复它们的说法和句式：");
    lines.push(...avoid.slice(0, 6).map((line) => `- ${line}`));
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

function fillTemplate(template: string, context: ProactiveContext): string {
  return template
    .replace("{media}", context.mediaTitle || "这个视频")
    .replace("{streak}", String(Math.max(20, Math.round(context.streakMinutes))))
    .replace("{event}", context.recentEvents[0] ?? "忙了一阵");
}

/** 模型不可用时用：按当前情境挑一句，并避开最近说过的。 */
export function pickFallback(context: ProactiveContext, history = readHistory()): string {
  const matching = FALLBACKS.filter((rule) => rule.when(context));
  const pool: string[] = [];
  for (const rule of matching) {
    for (const line of rule.lines) pool.push(fillTemplate(line, context));
  }
  const fresh = pool.filter((line) => !isRepeated(line, history));
  const candidates = fresh.length > 0 ? fresh : pool;
  if (candidates.length === 0) return "我在这儿，别忙坏了";
  return candidates[Math.floor(Math.random() * candidates.length)];
}
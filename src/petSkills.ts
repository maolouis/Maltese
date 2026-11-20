// 让小狗真的能干活：本地技能注册表 + 执行器。
//
// 设计取舍：
// - 不依赖模型的 function calling 能力（本地小模型经常不支持），而是让模型输出
//   一行 JSON：{"tool":"todo_add","args":{"text":"..."}}；前端解析后执行，再把结果
//   喂回模型做自然语言总结。
// - 所有技能都在前端执行，复用已有的 localStorage 存储与 Tauri 命令，
//   不需要额外的权限面。
import { invoke } from "@tauri-apps/api/core";
import { savePetCharacter, type PetCharacterId } from "./petCharacters";

export type SkillAction =
  | "todo_start"
  | "todo_pause"
  | "diary_add"
  | "diary_read"
  | "music_play"
  | "pet_settings"
  | "web_search"
  | "todo_add"
  | "todo_list"
  | "todo_done"
  | "open_url"
  | "open_app"
  | "media_control"
  | "clipboard_read"
  | "clipboard_write"
  | "agent_registry"
  | "agent_status"
  | "desktop_agents_status"
  | "video_taste"
  | "current_time";

export type SkillDefinition = {
  action: SkillAction;
  /** 内置分类：待办 / 电脑 / 媒体 / 剪贴板 / 时间 / agent */
  group: "todo" | "system" | "media" | "clipboard" | "time" | "diary" | "settings" | "web" | "agent";
  title: string;
  description: string;
  /** 给模型看的调用说明与示例 */
  example: string;
};

export const SKILLS: SkillDefinition[] = [
  {
    action: "todo_start",
    group: "todo",
    title: "开始专注",
    description: "开始给某件事计时（没有这条待办就顺手新建），其它进行中的待办自动暂停",
    example: '{"tool":"todo_start","args":{"text":"雅思口语"}}',
  },
  {
    action: "todo_pause",
    group: "todo",
    title: "暂停计时",
    description: "暂停正在计时的待办并累计本次时长",
    example: '{"tool":"todo_pause","args":{"keyword":"雅思"}}',
  },
  {
    action: "diary_add",
    group: "diary",
    title: "记日记",
    description: "把一段话写进今天的时间线日记",
    example: '{"tool":"diary_add","args":{"text":"今天把台球插件拆出来了，很有成就感"}}',
  },
  {
    action: "diary_read",
    group: "diary",
    title: "看今天日记",
    description: "读出今天已经记下的内容",
    example: '{"tool":"diary_read","args":{}}',
  },
  {
    action: "music_play",
    group: "media",
    title: "播放音乐",
    description: "开始播放系统当前播放器的音乐；没在放就唤起播放",
    example: '{"tool":"music_play","args":{}}',
  },
  {
    action: "pet_settings",
    group: "settings",
    title: "调整自己的设置",
    description: "改小狗自己的设置，目前支持 character（形象：小白 / 小鸡毛 / 双狗）",
    example: '{"tool":"pet_settings","args":{"key":"character","value":"小鸡毛"}}',
  },
  {
    action: "video_taste",
    group: "settings",
    title: "调整视频口味",
    description:
      "按主人一句话调整刷视频的喜好（少刷/多看某个分区或题材），只改视频口味画像，不改平台、时长、自动评论等其它设置",
    example: '{"tool":"video_taste","args":{"text":"少刷游戏区，多来点纪录片"}}',
  },
  {
    action: "web_search",
    group: "web",
    title: "联网查资料",
    description: "上网搜索资料，拿到结果后用自己的话回答主人",
    example: '{"tool":"web_search","args":{"query":"2026 雅思口语换题季时间"}}',
  },
  {
    action: "todo_add",
    group: "todo",
    title: "记待办",
    description: "把一句话记成待办",
    example: '{"tool":"todo_add","args":{"text":"下午三点和李总开会"}}',
  },
  {
    action: "todo_list",
    group: "todo",
    title: "看今天待办",
    description: "列出还没完成的待办",
    example: '{"tool":"todo_list","args":{}}',
  },
  {
    action: "todo_done",
    group: "todo",
    title: "完成待办",
    description: "按关键词把匹配的待办标记完成",
    example: '{"tool":"todo_done","args":{"keyword":"开会"}}',
  },
  {
    action: "open_url",
    group: "system",
    title: "打开网址",
    description: "用默认浏览器打开一个链接",
    example: '{"tool":"open_url","args":{"url":"https://www.bilibili.com"}}',
  },
  {
    action: "open_app",
    group: "system",
    title: "打开应用",
    description: "按名称启动本机应用（微信 / 网易云等）",
    example: '{"tool":"open_app","args":{"name":"微信"}}',
  },
  {
    action: "media_control",
    group: "media",
    title: "控制音乐",
    description: "播放 / 暂停 / 上一首 / 下一首",
    example: '{"tool":"media_control","args":{"command":"next"}}',
  },
  {
    action: "clipboard_read",
    group: "clipboard",
    title: "读剪贴板",
    description: "读当前剪贴板里的文字",
    example: '{"tool":"clipboard_read","args":{}}',
  },
  {
    action: "clipboard_write",
    group: "clipboard",
    title: "写剪贴板",
    description: "把一段文字放进剪贴板",
    example: '{"tool":"clipboard_write","args":{"text":"要复制的文字"}}',
  },
  {
    action: "desktop_agents_status",
    group: "agent",
    title: "看开了哪些 AI 应用",
    description: "列出桌面白名单里正在运行的 AI 助手（Claude/ChatGPT/Cursor/豆包等）、窗口标题，以及你现在正在用哪个",
    example: '{"tool":"desktop_agents_status","args":{}}',
  },
  {
    action: "agent_registry",
    group: "agent",
    title: "看有哪些 agent",
    description: "列出本机安装的 agent（codex / claude / 豆包 / DSH）以及是否可用、有哪些现成流水线",
    example: '{"tool":"agent_registry","args":{}}',
  },
  {
    action: "agent_status",
    group: "agent",
    title: "看谁在干活",
    description: "查看当前正在运行的 agent、排队长度和最近失败原因（只读）",
    example: '{"tool":"agent_status","args":{}}',
  },
  {
    action: "current_time",
    group: "time",
    title: "看时间",
    description: "读取当前日期时间",
    example: '{"tool":"current_time","args":{}}',
  },
];

export const SKILLS_STORAGE_KEY = "maltese-enabled-skills";
export const CUSTOM_SKILLS_STORAGE_KEY = "maltese-custom-skills";
export const MCP_SERVERS_STORAGE_KEY = "maltese-mcp-servers";

export type CustomSkill = {
  id: string;
  name: string;
  /** 注入到提示词里的说明：模型据此知道什么时候用它 */
  instructions: string;
};

export type McpServer = {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时只影响本次会话
  }
}

/** 这次新增的技能：老用户的已存清单里一次性补进去（之后仍可手动关闭）。 */
const SKILL_MIGRATION_KEY = "maltese-skills-migrated-20261114";
const NEW_SKILL_ACTIONS: SkillAction[] = [
  "todo_start",
  "todo_pause",
  "diary_add",
  "diary_read",
  "music_play",
  "pet_settings",
  "web_search",
];

/** Agent Hub 只读技能：单独一个迁移键，避免影响上面那批老迁移。 */
const AGENT_SKILLS_MIGRATION_KEY = "maltese-skills-migrated-20261119";
const AGENT_SKILL_ACTIONS: SkillAction[] = ["agent_registry", "agent_status", "desktop_agents_status"];

/** 视频口味技能：单独迁移键，老用户默认补进去，之后仍可手动关闭。 */
const VIDEO_TASTE_MIGRATION_KEY = "maltese-skills-migrated-20261119-video-taste";
const VIDEO_TASTE_ACTIONS: SkillAction[] = ["video_taste"];

const VIDEO_TASTE_KEYWORD =
  /多刷|少刷|多看|少看|不想看|别看|口味|刷点|来点|推荐.{0,4}区|(音乐|经济|财经|科技|数码|游戏|纪录|美食|生活|知识|动画|鬼畜|影视|体育|舞蹈|时尚|汽车|健身|旅行|学习|人文|科学)区/;

/**
 * 关键词快速通道：命中口味/分区相关词时直接进 video_taste 技能，不等模型决策。
 * 返回 null 表示交给模型判断。
 */
export function matchSkillByKeyword(
  text: string,
): { action: "video_taste"; via: "keyword" } | null {
  if (!text) return null;
  if (VIDEO_TASTE_KEYWORD.test(text)) {
    return { action: "video_taste", via: "keyword" };
  }
  return null;
}

export function loadEnabledSkills(): SkillAction[] {
  const stored = readJson<SkillAction[] | null>(SKILLS_STORAGE_KEY, null);
  if (!stored) return SKILLS.filter((skill) => skill.group !== "clipboard").map((s) => s.action);
  let enabled = stored;
  // 老用户：先补 2026-11-14 那批，再补 agent 只读技能；两批互不影响。
  if (!window.localStorage.getItem(SKILL_MIGRATION_KEY)) {
    enabled = Array.from(new Set([...enabled, ...NEW_SKILL_ACTIONS]));
    writeJson(SKILLS_STORAGE_KEY, enabled);
    try {
      window.localStorage.setItem(SKILL_MIGRATION_KEY, "1");
    } catch {
      // 忽略
    }
  }
  if (!window.localStorage.getItem(AGENT_SKILLS_MIGRATION_KEY)) {
    enabled = Array.from(new Set([...enabled, ...AGENT_SKILL_ACTIONS]));
    writeJson(SKILLS_STORAGE_KEY, enabled);
    try {
      window.localStorage.setItem(AGENT_SKILLS_MIGRATION_KEY, "1");
    } catch {
      // 忽略
    }
  }
  if (!window.localStorage.getItem(VIDEO_TASTE_MIGRATION_KEY)) {
    enabled = Array.from(new Set([...enabled, ...VIDEO_TASTE_ACTIONS]));
    writeJson(SKILLS_STORAGE_KEY, enabled);
    try {
      window.localStorage.setItem(VIDEO_TASTE_MIGRATION_KEY, "1");
    } catch {
      // 忽略
    }
  }
  return enabled;
}

export function saveEnabledSkills(actions: SkillAction[]) {
  writeJson(SKILLS_STORAGE_KEY, actions);
}

export function loadCustomSkills(): CustomSkill[] {
  return readJson<CustomSkill[]>(CUSTOM_SKILLS_STORAGE_KEY, []);
}

export function saveCustomSkills(skills: CustomSkill[]) {
  writeJson(CUSTOM_SKILLS_STORAGE_KEY, skills);
}

export function loadMcpServers(): McpServer[] {
  return readJson<McpServer[]>(MCP_SERVERS_STORAGE_KEY, []);
}

export function saveMcpServers(servers: McpServer[]) {
  writeJson(MCP_SERVERS_STORAGE_KEY, servers);
}

/** 生成给模型的系统提示：可用动作 + 输出格式。 */
export function skillsPrompt(enabled: SkillAction[], custom: CustomSkill[]): string {
  const active = SKILLS.filter((skill) => enabled.includes(skill.action));
  const lines = [
    "你可以调用本机能力帮主人做事。需要动手时，只输出一行 JSON，不要额外解释：",
    '{"tool":"动作名","args":{...}}',
    "可用的动作：",
    ...active.map((skill) => `- ${skill.action}：${skill.description}；示例 ${skill.example}`),
    "如果不需要动手（只是聊天），就直接用中文回答，不要输出 JSON。",
    "判断口诀：「我要开始学/做…」→ todo_start；「休息一下 / 暂停」→ todo_pause；「记一下今天… / 写日记」→ diary_add；「今天都记了什么」→ diary_read；「放点音乐 / 播放音乐」→ music_play；「换个形象 / 换成小鸡毛」→ pet_settings；「帮我查 / 搜一下 / 网上看看…」→ web_search；「有哪些 agent / 装了哪些模型」→ agent_registry；「谁在干活 / 有几个在跑」→ agent_status；「少刷游戏区 / 多看纪录片 / 别看直播」→ video_taste。",
    "一次只调用一个动作。动作执行完会告诉你结果，再据此用中文回答主人。",
  ];
  if (custom.length > 0) {
    lines.push("额外技能（照着主人的说明处理，需要动手时仍然用上面的 JSON 格式）：");
    for (const skill of custom) {
      lines.push(`- ${skill.name}：${skill.instructions}`);
    }
  }
  return lines.join("\n");
}

export type SkillResult = { ok: boolean; message: string };

const TODOS_KEY = "focusd-island-todos";
const ACTIVE_TODO_KEY = "focusd-island-active-todo";
const DIARY_KEY = "focusd-island-diary-events";

type DiaryEntry = { id: string; date: string; at: number; kind: string; text: string };

function todayString(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function appendDiary(kind: string, text: string) {
  const events = readJson<DiaryEntry[]>(DIARY_KEY, []);
  const at = Date.now();
  events.push({ id: createId(), date: todayString(new Date(at)), at, kind, text });
  writeJson(DIARY_KEY, events.slice(-500));
  window.dispatchEvent(new Event("maltese-diary-updated"));
}

type StoredTodo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number | null;
  startedAt?: number | null;
  activeSince?: number | null;
  elapsedMs?: number;
};

function readTodos(): StoredTodo[] {
  return readJson<StoredTodo[]>(TODOS_KEY, []);
}

function writeTodos(todos: StoredTodo[]) {
  writeJson(TODOS_KEY, todos);
  // 主窗口用 storage 事件同步（同窗口写入不会触发，所以额外派发一次）。
  window.dispatchEvent(new Event("maltese-todos-updated"));
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 执行模型给出的动作。任何异常都收敛成 ok=false，不打断对话。 */
async function runSkillCore(
  action: string,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  try {
    switch (action) {
      case "todo_add": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, message: "没有给出待办内容。" };
        const todos = readTodos();
        todos.push({ id: createId(), title: text, completed: false, createdAt: Date.now() });
        writeTodos(todos);
        return { ok: true, message: `已记下待办：${text}` };
      }
      case "todo_list": {
        const pending = readTodos().filter((todo) => !todo.completed);
        if (pending.length === 0) return { ok: true, message: "现在没有未完成的待办。" };
        return {
          ok: true,
          message: `未完成待办 ${pending.length} 条：${pending.map((todo) => todo.title).join("；")}`,
        };
      }
      case "todo_done": {
        const keyword = String(args.keyword ?? "").trim();
        if (!keyword) return { ok: false, message: "没有给出要完成的待办关键词。" };
        const todos = readTodos();
        let hit = 0;
        for (const todo of todos) {
          if (!todo.completed && todo.title.includes(keyword)) {
            todo.completed = true;
            todo.completedAt = Date.now();
            todo.activeSince = null;
            hit += 1;
          }
        }
        if (hit === 0) return { ok: false, message: `没找到包含「${keyword}」的待办。` };
        writeTodos(todos);
        return { ok: true, message: `已完成 ${hit} 条包含「${keyword}」的待办。` };
      }
      case "todo_start": {
        const text = String(args.text ?? args.keyword ?? "").trim();
        if (!text) return { ok: false, message: "没有说要开始做什么。" };
        const todos = readTodos();
        let target = todos.find((todo) => !todo.completed && todo.title.includes(text));
        if (!target) {
          target = { id: createId(), title: text, completed: false, createdAt: Date.now() };
          todos.push(target);
        }
        const now = Date.now();
        for (const todo of todos) {
          if (todo.id !== target.id && todo.activeSince) {
            todo.elapsedMs = (todo.elapsedMs ?? 0) + (now - todo.activeSince);
            todo.activeSince = null;
          }
        }
        target.startedAt = target.startedAt ?? now;
        target.activeSince = now;
        writeTodos(todos);
        try {
          window.localStorage.setItem(ACTIVE_TODO_KEY, target.id);
        } catch {
          // 忽略
        }
        appendDiary("todo", `开始专注「${target.title}」`);
        return { ok: true, message: `已开始给「${target.title}」计时，其它进行中的待办已暂停。` };
      }
      case "todo_pause": {
        const keyword = String(args.keyword ?? args.text ?? "").trim();
        const todos = readTodos();
        const now = Date.now();
        let hit = 0;
        let lastTitle = "";
        for (const todo of todos) {
          if (todo.activeSince && (!keyword || todo.title.includes(keyword))) {
            todo.elapsedMs = (todo.elapsedMs ?? 0) + (now - todo.activeSince);
            todo.activeSince = null;
            hit += 1;
            lastTitle = todo.title;
            appendDiary("todo", `暂停「${todo.title}」，本次累计 ${Math.round((todo.elapsedMs ?? 0) / 60000)} 分钟`);
          }
        }
        if (hit === 0) return { ok: false, message: keyword ? `没有正在计时的「${keyword}」待办。` : "现在没有在计时的待办。" };
        try {
          window.localStorage.removeItem(ACTIVE_TODO_KEY);
        } catch {
          // 忽略
        }
        writeTodos(todos);
        return { ok: true, message: `已暂停 ${hit} 条待办的计时（${lastTitle}）。` };
      }
      case "diary_add": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, message: "没有要记的内容。" };
        appendDiary("pet", text);
        return { ok: true, message: `已写进今天的日记：${text}` };
      }
      case "diary_read": {
        const today = todayString();
        const events = readJson<DiaryEntry[]>(DIARY_KEY, []).filter((event) => event.date === today);
        if (events.length === 0) return { ok: true, message: "今天还没有记录，说「记一下…」就能写。" };
        return {
          ok: true,
          message: `今天记了 ${events.length} 条：${events
            .map((event) => `${new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} ${event.text}`)
            .join("；")}`,
        };
      }
      case "music_play": {
        const state = await invoke<{ available: boolean; playbackStatus: string; title: string | null }>(
          "get_media_state",
          { target: null },
        ).catch(() => null);
        if (state && !state.available) {
          // 一个播放器都没有：帮忙把常见的音乐软件叫起来。
          const players = await invoke<Array<{ label: string; appId: string }>>("discover_start_apps", {
            query: "音乐",
          }).catch(() => []);
          const player = players.find((app) => /音乐|music|spotify/i.test(app.label));
          if (player) {
            await invoke("launch_start_app", { appId: player.appId });
            return { ok: true, message: `已帮你打开 ${player.label}，进去点一下播放就有音乐了。` };
          }
          return { ok: false, message: "没找到正在运行的播放器，也没找到音乐软件，先打开一个再叫我。" };
        }
        if (state && state.playbackStatus === "playing") {
          return { ok: true, message: `音乐已经在放了${state.title ? `：${state.title}` : ""}。` };
        }
        await invoke("media_play_pause", { target: null });
        return { ok: true, message: "已帮你开始播放音乐。" };
      }
      case "pet_settings": {
        const key = String(args.key ?? "").trim().toLowerCase();
        const value = String(args.value ?? "").trim();
        if (key === "character" || key === "形象") {
          const map: Record<string, string> = {
            小白: "xiaobai",
            小鸡毛: "xiaojimao",
            双狗: "duo",
            两只: "duo",
            xiaobai: "xiaobai",
            xiaojimao: "xiaojimao",
            duo: "duo",
          };
          const id = map[value] ?? map[value.toLowerCase()];
          if (!id) return { ok: false, message: "形象只支持：小白 / 小鸡毛 / 双狗。" };
          savePetCharacter(id as PetCharacterId);
          return { ok: true, message: `已把形象换成${value}。` };
        }
        return { ok: false, message: "目前只能帮我换形象（character），其它设置请在设置面板里改。" };
      }
      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, message: "没有给出要搜索的内容。" };
        const hits = await invoke<Array<{ title: string; url: string; snippet: string }>>("web_search", { query });
        if (hits.length === 0) return { ok: false, message: `没搜到「${query}」的结果。` };
        const text = hits
          .slice(0, 5)
          .map((hit, index) => `${index + 1}. ${hit.title}：${hit.snippet}（${hit.url}）`)
          .join("\n");
        return { ok: true, message: `关于「${query}」搜到这些资料：
${text}` };
      }
      case "open_url": {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, message: "只支持 http/https 链接。" };
        await invoke("open_local_path", { path: url });
        return { ok: true, message: `已经帮你打开 ${url}` };
      }
      case "open_app": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, message: "没有给出应用名。" };
        const needle = name.toLowerCase();
        // 开始菜单登记的商店应用 + 桌面/开始菜单里的 exe、lnk，两路一起找。
        const [storeApps, fileApps] = await Promise.all([
          invoke<Array<{ label: string; appId: string }>>("discover_start_apps", { query: null }).catch(() => []),
          invoke<Array<{ label: string; path: string }>>("discover_installed_apps", { query: null }).catch(() => []),
        ]);
        const score = (label: string) => {
          const lower = label.toLowerCase();
          if (lower === needle) return 0;
          if (lower.startsWith(needle)) return 1;
          if (lower.includes(needle)) return 2;
          if (needle.includes(lower)) return 3;
          return 99;
        };
        const storeHit = storeApps
          .map((app) => ({ app, rank: score(app.label) }))
          .filter((item) => item.rank < 99)
          .sort((a, b) => a.rank - b.rank)[0];
        const fileHit = fileApps
          .map((app) => ({ app, rank: score(app.label) }))
          .filter((item) => item.rank < 99)
          .sort((a, b) => a.rank - b.rank)[0];
        if (storeHit && (!fileHit || storeHit.rank <= fileHit.rank)) {
          await invoke("launch_start_app", { appId: storeHit.app.appId });
          return { ok: true, message: `已经打开 ${storeHit.app.label}` };
        }
        if (fileHit) {
          await invoke("launch_custom_shortcut", { path: fileHit.app.path });
          return { ok: true, message: `已经打开 ${fileHit.app.label}` };
        }
        return { ok: false, message: `没找到叫「${name}」的应用，可以说得再具体一点。` };
      }
      case "media_control": {
        const requested = String(args.command ?? "play_pause").toLowerCase();
        const command =
          requested === "next" || requested === "下一首"
            ? "next"
            : requested === "previous" || requested === "prev" || requested === "上一首"
              ? "previous"
              : "toggle";
        await invoke("media_press_key", { command });
        return { ok: true, message: `已执行音乐命令：${command}` };
      }
      case "clipboard_read": {
        const text = await invoke<string>("read_clipboard_text");
        return { ok: true, message: text ? `剪贴板内容：${text.slice(0, 500)}` : "剪贴板是空的。" };
      }
      case "clipboard_write": {
        const text = String(args.text ?? "");
        if (!text) return { ok: false, message: "没有要写入的文字。" };
        await invoke("set_clipboard_text", { text });
        return { ok: true, message: "已经放进剪贴板。" };
      }
      case "desktop_agents_status": {
        const snapshot = await invoke<{
          agents: Array<{
            id: string;
            displayName: string;
            running: boolean;
            windowTitle: string | null;
            isForeground: boolean;
            lastActiveAgoSeconds: number | null;
          }>;
          foreground: { displayName?: string; title: string; agentId: string | null } | null;
        }>("desktop_agents_status", { refresh: false });
        const running = snapshot.agents.filter((agent) => agent.running);
        if (running.length === 0) {
          const names = snapshot.agents.map((agent) => agent.displayName).join("、");
          return { ok: true, message: `现在没有开着白名单里的 AI 应用（${names}）。` };
        }
        const lines = [
          `开着 ${running.length} 个：${running
            .map((agent) => `${agent.displayName}${agent.windowTitle ? `（${agent.windowTitle}）` : ""}`)
            .join("、")}。`,
        ];
        const foreground = running.find((agent) => agent.isForeground);
        if (foreground) {
          lines.push(`你现在正在用：${foreground.displayName}。`);
        } else if (snapshot.foreground?.title) {
          lines.push(`当前前台是「${snapshot.foreground.title}」，不在白名单里。`);
        } else {
          lines.push("当前没有前台窗口。");
        }
        return { ok: true, message: lines.join("") };
      }
      case "agent_registry": {
        const registry = await invoke<{
          agents: Array<{
            id: string;
            displayName: string;
            kind: string;
            enabled: boolean;
            available: boolean;
            unavailableReason: string | null;
          }>;
          pipelines: Array<{ id: string; title: string }>;
        }>("get_agent_registry", { refresh: false });
        const usable = registry.agents.filter((agent) => agent.enabled && agent.available);
        const missing = registry.agents.filter((agent) => agent.enabled && !agent.available);
        const lines: string[] = [];
        lines.push(
          usable.length > 0
            ? `可用的 agent ${usable.length} 个：${usable.map((agent) => agent.displayName).join("、")}。`
            : "现在没有可用的 agent，先安装 codex / claude，或在 Agent 控制台里配置。",
        );
        for (const agent of missing) {
          lines.push(`${agent.displayName} 不可用：${agent.unavailableReason ?? "未安装"}`);
        }
        if (registry.pipelines.length > 0) {
          lines.push(`流水线：${registry.pipelines.map((pipeline) => pipeline.title).join("、")}。`);
        }
        return { ok: true, message: lines.join("\n") };
      }
      case "agent_status": {
        const [status, desktop] = await Promise.all([
          invoke<{
            running: Array<{ agentId: string; agentName: string; promptPreview: string; startedAt: number }>;
            queue: Record<string, number>;
            recentErrors: Array<{ at: number; agentId: string; message: string }>;
          }>("agent_hub_status"),
          invoke<{
            agents: Array<{ displayName: string; running: boolean; isForeground: boolean; windowTitle: string | null }>;
            foreground: { title: string; agentId: string | null } | null;
          }>("desktop_agents_status", { refresh: false }).catch(() => null),
        ]);
        const parts: string[] = [];
        const queueTotal = Object.values(status.queue).reduce((sum, value) => sum + value, 0);
        if (status.running.length > 0) {
          const runningText = status.running
            .map((entry) => {
              const startedAt = entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
              return `${entry.agentName}（${startedAt} 开始）`;
            })
            .join("、");
          parts.push(`命令行 agent 正在跑 ${status.running.length} 个：${runningText}`);
        }
        if (queueTotal > 0) {
          const queueText = Object.entries(status.queue)
            .filter(([, count]) => count > 0)
            .map(([agentId, count]) => `${agentId} ${count} 个`)
            .join("、");
          parts.push(`排队 ${queueTotal} 个（${queueText}）`);
        }
        if (status.recentErrors.length > 0) {
          const last = status.recentErrors[status.recentErrors.length - 1];
          parts.push(`最近错误：${last.message}`);
        }
        if (desktop) {
          const desktopRunning = desktop.agents.filter((agent) => agent.running);
          if (desktopRunning.length > 0) {
            const foreground = desktopRunning.find((agent) => agent.isForeground);
            parts.push(
              `桌面 AI 应用开着 ${desktopRunning.length} 个：${desktopRunning.map((agent) => agent.displayName).join("、")}${
                foreground ? `（前台：${foreground.displayName}）` : ""
              }`,
            );
          } else {
            parts.push("桌面没有开着白名单里的 AI 应用");
          }
        }
        if (parts.length === 0) return { ok: true, message: "现在没有 agent 在跑，也没有开着的桌面 AI 应用。" };
        return { ok: true, message: parts.join("；") };
      }
      case "video_taste": {
        const text = String(args.text ?? args.query ?? args.utterance ?? "").trim();
        if (!text) {
          return { ok: false, message: "没说得太具体，是想多看还是少看哪个分区？（比如「少刷游戏区」）" };
        }
        const report = await invoke<{
          reply: string;
          positiveTags: string[];
          negativeTags: string[];
          moves: string[];
        }>("video_update_taste", { text });
        // 通知已挂载的视频面板刷新口味标签。
        window.dispatchEvent(new CustomEvent("video-taste-changed"));
        return { ok: true, message: report.reply };
      }
      case "current_time": {
        const now = new Date();
        return {
          ok: true,
          message: `现在是 ${now.toLocaleString("zh-CN", { hour12: false })}`,
        };
      }
      default:
        return { ok: false, message: `不认识的动作：${action}` };
    }
  } catch (error) {
    return { ok: false, message: `执行失败：${String(error)}` };
  }
}

/** 技能 → 任务类型映射：确定性上报，覆盖待办 / 搜索 / 设置类快任务。 */
const SKILL_TASK_KINDS: Record<string, string> = {
  todo_add: "todo",
  todo_list: "todo",
  todo_done: "todo",
  todo_start: "todo",
  todo_pause: "todo",
  web_search: "search",
  pet_settings: "settings",
  open_app: "settings",
  open_url: "settings",
  media_control: "settings",
  music_play: "settings",
};

/**
 * 技能入口：执行前后把任务进度上报给 Rust 状态机（失败不影响技能本身）。
 * 任务卡片的 1s 轮询会看到这些确定性任务。
 */
export async function runSkill(
  action: string,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  const kind = SKILL_TASK_KINDS[action];
  const taskId = kind ? `skill-${action}-${Date.now()}` : null;
  if (taskId) {
    const title = SKILLS.find((skill) => skill.action === action)?.title ?? action;
    try {
      await invoke("task_begin", {
        kind,
        title,
        id: taskId,
        expectedSecs: kind === "search" ? 120 : 60,
      });
      await invoke("task_advance", { id: taskId, stage: "executing" });
    } catch {
      // 任务状态机不可用时不影响技能
    }
  }
  const result = await runSkillCore(action, args);
  if (taskId) {
    try {
      await invoke("task_end", {
        id: taskId,
        stage: result.ok ? "done" : "failed",
        error: result.ok ? null : result.message,
        detail: result.message.slice(0, 120),
      });
    } catch {
      // 忽略上报失败
    }
  }
  return result;
}

/** 从模型回复里解析出动作 JSON；没有就返回 null。 */
export function parseSkillCall(text: string): { action: string; args: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const inline = trimmed.match(/\{[\s\S]*"tool"[\s\S]*\}/);
  if (inline) candidates.push(inline[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { tool?: unknown; action?: unknown; args?: unknown };
      const action = typeof parsed.tool === "string" ? parsed.tool : parsed.action;
      if (typeof action !== "string") continue;
      const args =
        parsed.args && typeof parsed.args === "object"
          ? (parsed.args as Record<string, unknown>)
          : {};
      return { action, args };
    } catch {
      // 换下一个候选
    }
  }
  return null;
}
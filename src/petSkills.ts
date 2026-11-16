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
  | "current_time";

export type SkillDefinition = {
  action: SkillAction;
  /** 内置分类：待办 / 电脑 / 媒体 / 剪贴板 / 时间 */
  group: "todo" | "system" | "media" | "clipboard" | "time" | "diary" | "settings" | "web";
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

export function loadEnabledSkills(): SkillAction[] {
  const stored = readJson<SkillAction[] | null>(SKILLS_STORAGE_KEY, null);
  if (!stored) return SKILLS.filter((skill) => skill.group !== "clipboard").map((s) => s.action);
  if (!window.localStorage.getItem(SKILL_MIGRATION_KEY)) {
    const merged = Array.from(new Set([...stored, ...NEW_SKILL_ACTIONS]));
    writeJson(SKILLS_STORAGE_KEY, merged);
    try {
      window.localStorage.setItem(SKILL_MIGRATION_KEY, "1");
    } catch {
      // 忽略
    }
    return merged;
  }
  return stored;
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
    "判断口诀：「我要开始学/做…」→ todo_start；「休息一下 / 暂停」→ todo_pause；「记一下今天… / 写日记」→ diary_add；「今天都记了什么」→ diary_read；「放点音乐 / 播放音乐」→ music_play；「换个形象 / 换成小鸡毛」→ pet_settings；「帮我查 / 搜一下 / 网上看看…」→ web_search。",
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
export async function runSkill(
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
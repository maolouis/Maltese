// 让小狗真的能干活：本地技能注册表 + 执行器。
//
// 设计取舍：
// - 不依赖模型的 function calling 能力（本地小模型经常不支持），而是让模型输出
//   一行 JSON：{"tool":"todo_add","args":{"text":"..."}}；前端解析后执行，再把结果
//   喂回模型做自然语言总结。
// - 所有技能都在前端执行，复用已有的 localStorage 存储与 Tauri 命令，
//   不需要额外的权限面。
import { invoke } from "@tauri-apps/api/core";

export type SkillAction =
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
  group: "todo" | "system" | "media" | "clipboard" | "time";
  title: string;
  description: string;
  /** 给模型看的调用说明与示例 */
  example: string;
};

export const SKILLS: SkillDefinition[] = [
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

export function loadEnabledSkills(): SkillAction[] {
  const stored = readJson<SkillAction[] | null>(SKILLS_STORAGE_KEY, null);
  if (!stored) return SKILLS.filter((skill) => skill.group !== "clipboard").map((s) => s.action);
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
      case "open_url": {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, message: "只支持 http/https 链接。" };
        await invoke("open_local_path", { path: url });
        return { ok: true, message: `已经帮你打开 ${url}` };
      }
      case "open_app": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, message: "没有给出应用名。" };
        const apps = await invoke<Array<{ label: string; appId: string }>>(
          "discover_start_apps",
          { query: null },
        );
        const target = apps.find(
          (app) => app.label === name || app.label.includes(name) || name.includes(app.label),
        );
        if (!target) return { ok: false, message: `没找到叫「${name}」的应用。` };
        await invoke("launch_start_app", { appId: target.appId });
        return { ok: true, message: `已经打开 ${target.label}` };
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
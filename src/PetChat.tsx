import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, Hand, ImagePlus, LoaderCircle, RotateCcw, Send, Settings2, Square, Trash2, Wrench, X } from "lucide-react";
import { useTranslation } from "./i18n";
import { LocalChatSettings } from "./LocalChatSettings";
import { PetSkillsSettings } from "./PetSkillsSettings";
import { ChatText } from "./ChatText";
import { ChatReasoning } from "./ChatReasoning";
import {
  loadCustomSkills,
  loadEnabledSkills,
  parseSkillCall,
  runSkill,
  skillsPrompt,
} from "./petSkills";
import { usePetCharacter, PET_CHARACTER_LABELS } from "./petCharacters";
import { petAvatarUrl } from "./petAvatars";
import {
  loadLocalChatConfig,
  LOCAL_CHAT_UPDATED_EVENT,
  thinkingBudget,
  thinkingEffort,
  type LocalChatConfig,
} from "./localChat";
import {
  CHAT_TOTAL_TIMEOUT_MS,
  chatMaxTokens,
  chatTimeouts,
  clearChatBusy,
  describeChatError,
  isTemplateRejection,
  markChatBusy,
  shouldAbortStream,
  shouldPersistReply,
} from "./chatGuard";
import { buildChatVitalsContext, loadVitalsSummary, type VitalsSummary } from "./petContext";
import { PetStateBar } from "./PetStateBar";
import {
  detectThresholdCross,
  shouldShowNotice,
  STATE_NOTICE_AT_KEY,
} from "./petStateBarLogic";
import "./PetChat.css";

type DshChatReply = { text: string; sessionId: string | null };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  imageCount?: number;
  /** 消息里展示的缩略图（data URL）；发送给模型的是另一份更大的图。 */
  thumbnails?: string[];
  /** 小狗实际执行了什么动作（例如记待办），显示成一条小提示。 */
  toolNote?: string;
  /** 模型的思考过程（折叠展示）。 */
  reasoning?: string;
};

type LocalChatStreamEvent = {
  requestId: string;
  kind: "delta" | "done" | "error" | "reasoning";
  text: string;
};

const MESSAGES_KEY = "focusd-island-pet-chat-messages";
const MAX_IMAGES = 4;
const SEND_IMAGE_MAX_SIDE = 1280;
const THUMB_IMAGE_MAX_SIDE = 360;

/** 把图片文件压到指定最长边，返回 data URL（避免把几 MB 的原图塞进请求/存储）。 */
async function fileToDataUrl(file: File, maxSide: number, quality: number): Promise<string> {
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
const SESSION_KEY = "focusd-island-pet-chat-session";
const MAX_MESSAGES = 60;

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把小狗状态/近期互动拼成一条 system 消息放进历史（不污染用户消息）。
 * 没有状态数据时返回原历史，提示词与旧版完全一致。
 */
function loadMessages(): ChatMessage[] {
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

export function PetChat() {
  const t = useTranslation();
  const character = usePetCharacter();
  const avatarSrc = petAvatarUrl(character);
  const avatarName = PET_CHARACTER_LABELS[character];
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    window.localStorage.getItem(SESSION_KEY),
  );
  const [draft, setDraft] = useState("");
  // 待发送的图片：sendImages 给模型，thumbnails 存消息里展示。
  const [attachments, setAttachments] = useState<{
    send: string;
    thumb: string;
  }[]>([]);
  const [streamingReply, setStreamingReply] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  // 模型「开思考」时首字会晚很多，用计时器让用户看到确实在工作。
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [chatConfig, setChatConfig] = useState<LocalChatConfig>(loadLocalChatConfig);
  // 是否展示思考过程：模型设置里的开关，默认展示但折叠。
  const showThinking = chatConfig.showThinking !== false;
  const thinkingOn = chatConfig.thinkingDepth !== "off";
  const thinkingLabel =
    chatConfig.thinkingDepth === "shallow"
      ? "浅"
      : chatConfig.thinkingDepth === "deep"
        ? "深"
        : chatConfig.thinkingDepth === "normal"
          ? "标准"
          : "关";
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-agent-mode") !== "off";
    } catch {
      return true;
    }
  });
  const [enabledSkills] = useState(loadEnabledSkills);
  const [customSkills] = useState(loadCustomSkills);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 正在进行的流式请求：用于「停止生成」和防止旧请求回写。 */
  const activeRequestRef = useRef<{ requestId: string; cancelled: boolean } | null>(null);
  /** 最近一次失败的提问：给「重试」按钮用。 */
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);
  /** 首字是否已经到达（分级超时用）。 */
  const firstDeltaRef = useRef(false);
  // 聊天里的「小狗状态条」+ 阈值跨越灰色提示（只展示，不写记录、不发给模型）。
  const [stateNotices, setStateNotices] = useState<string[]>([]);
  const prevVitalsRef = useRef<VitalsSummary | null>(loadVitalsSummary());
  const [noticeAtInitial] = useState<number>(() => {
    try {
      const raw = Number(window.localStorage.getItem(STATE_NOTICE_AT_KEY));
      return Number.isFinite(raw) ? raw : 0;
    } catch {
      return 0;
    }
  });
  const lastNoticeAtRef = useRef<number>(noticeAtInitial);
  useEffect(() => {
    const refresh = () => {
      const next = loadVitalsSummary();
      const cross = detectThresholdCross(
        prevVitalsRef.current,
        next,
        PET_CHARACTER_LABELS[character as keyof typeof PET_CHARACTER_LABELS] ?? "小狗",
      );
      prevVitalsRef.current = next;
      if (!cross) return;
      const now = Date.now();
      if (!shouldShowNotice(lastNoticeAtRef.current, now)) return;
      lastNoticeAtRef.current = now;
      try {
        window.localStorage.setItem(STATE_NOTICE_AT_KEY, String(now));
      } catch {
        // 忽略
      }
      setStateNotices((current) => [...current.slice(-2), cross.text]);
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("maltese-pet-vitals-changed", refresh);
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("maltese-pet-vitals-changed", refresh);
      window.clearInterval(timer);
    };
  }, [character]);

  // 打开聊天总是停在最新一条：挂载时直接跳到底部（不要动画），
  // 之后消息变化、窗口/面板高度变化（展开动画、聊天框高度设置）都重新贴底。
  // 之前只在 messages 变化时滚一次，面板还在播放展开动画，scrollHeight 还没长完，
  // 结果打开就停在上方，得手动往下翻。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages, busy, streamingReply]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!busy) {
      setWaitSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setWaitSeconds(0);
    const timer = window.setInterval(() => {
      setWaitSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const sync = () => setChatConfig(loadLocalChatConfig());
    window.addEventListener("storage", sync);
    window.addEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    };
  }, []);

  const persist = useCallback((next: ChatMessage[]) => {
    const trimmed = next.slice(-MAX_MESSAGES);
    setMessages(trimmed);
    try {
      window.localStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
    } catch {
      // 存储满了也不影响当前会话。
    }
  }, []);

  const addImages = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setError(t.chat.imageLimit(MAX_IMAGES));
      return;
    }
    setError(null);
    const next: { send: string; thumb: string }[] = [];
    for (const file of imageFiles.slice(0, room)) {
      try {
        const send = await fileToDataUrl(file, SEND_IMAGE_MAX_SIDE, 0.9);
        if (!send) continue;
        next.push({ send, thumb: await fileToDataUrl(file, THUMB_IMAGE_MAX_SIDE, 0.72) });
      } catch {
        setError(t.chat.imageReadFailed);
      }
    }
    if (next.length > 0) {
      setAttachments((current) => [...current, ...next].slice(0, MAX_IMAGES));
    }
  }, [attachments.length, t.chat.imageLimit, t.chat.imageReadFailed]);

  // 非流式的模型调用：给「先决定动作、再总结」这类两步流程用。
  const askModel = useCallback(
    async (
      message: string,
      history: ChatMessage[],
      images: string[] | null,
      options?: { maxTokens?: number; temperature?: number },
    ) => {
      if (chatConfig.backend === "dsh") {
        const reply = await invoke<DshChatReply>("dsh_chat", {
          message,
          sessionId,
          character,
        });
        if (reply.sessionId) {
          setSessionId(reply.sessionId);
          window.localStorage.setItem(SESSION_KEY, reply.sessionId);
        }
        return reply.text;
      }
      // 思考深度按设置传入：关闭时不思考，深档给更多推理预算。
      const depth = chatConfig.thinkingDepth;
      const ensureModel = async () => {
        try {
          const ready = await invoke<boolean>("ensure_local_model", { baseUrl: chatConfig.baseUrl });
          return Boolean(ready);
        } catch {
          return false;
        }
      };
      try {
        return await invoke<string>("local_chat_stream", {
          requestId: createId(),
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
          character,
          images: images && images.length > 0 ? images : null,
          settings: {
            maxTokens: options?.maxTokens ?? chatConfig.maxTokens,
            temperature: options?.temperature ?? chatConfig.temperature,
            topP: chatConfig.topP,
            // 判断/总结这类短调用一律关掉思考，否则会被思考吃光预算。
            enableThinking: options ? false : depth !== "off",
            reasoningEffort: options ? "none" : thinkingEffort(depth),
            reasoningBudgetTokens: options ? 0 : thinkingBudget(depth),
          },
        });
      } catch (streamError) {
        // 连不上：先看是不是 Strata 没开，开了再试一次；仍失败就退回非流式。
        const text = String(streamError);
        if (text.includes("连接不到") || text.includes("Connection")) {
          const ready = await ensureModel();
          if (ready) {
            try {
              return await invoke<string>("local_chat_stream", {
                requestId: createId(),
                baseUrl: chatConfig.baseUrl,
                model: chatConfig.model,
                apiKey: chatConfig.apiKey.trim() || null,
                message,
                history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
                character,
                images: images && images.length > 0 ? images : null,
                settings: {
                  maxTokens: options?.maxTokens ?? chatConfig.maxTokens,
                  temperature: options?.temperature ?? chatConfig.temperature,
                  topP: chatConfig.topP,
                  enableThinking: options ? false : depth !== "off",
                  reasoningEffort: options ? "none" : thinkingEffort(depth),
                  reasoningBudgetTokens: options ? 0 : thinkingBudget(depth),
                },
              });
            } catch {
              // 继续走非流式
            }
          }
        }
        return invoke<string>("local_chat", {
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-16).map((item) => ({ role: item.role, content: item.text })),
          character,
          images: images && images.length > 0 ? images : null,
        });
      }
    },
    [
      character,
      chatConfig.apiKey,
      chatConfig.backend,
      chatConfig.baseUrl,
      chatConfig.maxTokens,
      chatConfig.model,
      chatConfig.temperature,
      chatConfig.thinkingDepth,
      chatConfig.topP,
      sessionId,
    ],
  );
  // 带界面的流式回复：边生成边把字显示出来，并把最终文本返回给调用方。
  // 带界面的流式回复：边生成边把字显示出来，并把最终文本返回给调用方。
  // 超时策略（实测修正）：用「空闲 watchdog」而不是固定首字 8s —— 本机首次 prefill 可到
  // 16–55s；只要还有事件就不算卡死；一旦开始输出，只看 20s 空窗与 120s 总时长。
  // 模板不兼容自动降级：注入状态上下文被 400 拒绝时，去掉注入重试一次，不让整条消息失败。
  const streamLocalReply = useCallback(
    async (message: string, history: ChatMessage[], images: string[]) => {
      const depth = chatConfig.thinkingDepth;
      const historyTurns = history.slice(-16).map((item) => ({ role: item.role, content: item.text }));

      const runAttempt = async (injectVitals: boolean): Promise<string> => {
        const requestId = createId();
        const active = { requestId, cancelled: false };
        activeRequestRef.current = active;
        firstDeltaRef.current = false;
        const startedAt = Date.now();
        let lastActivityAt: number | null = null;
        let rejectGuard: ((error: Error) => void) | null = null;
        const guard = new Promise<never>((_, reject) => {
          rejectGuard = reject;
        });
        const failWith = (reason: string) => {
          if (active.cancelled) return;
          active.cancelled = true;
          // 让 Rust 侧尽快断开连接、释放模型槽位。
          void invoke("local_chat_cancel", { requestId }).catch(() => undefined);
          rejectGuard?.(new Error(reason));
        };
        let watchdog: number | null = null;
        const unlisten = chatConfig.stream
          ? await listen<LocalChatStreamEvent>("local-chat-stream", (event) => {
            if (event.payload.requestId !== requestId || active.cancelled) return;
            // 任何事件都算「还活着」：思考流也算，避免思考档位被首字超时误杀。
            lastActivityAt = Date.now();
            if (event.payload.kind === "delta") {
              firstDeltaRef.current = true;
              setStreamingReply((current) => current + event.payload.text);
            } else if (event.payload.kind === "reasoning") {
              setStreamingReasoning((current) => current + event.payload.text);
            } else if (event.payload.kind === "error") {
              setError(event.payload.text);
            }
          })
          : null;
        try {
          watchdog = window.setInterval(() => {
            if (active.cancelled) return;
            const now = Date.now();
            if (!chatConfig.stream) {
              // 非流式没有中间事件，只按总时长兜底。
              if (now - startedAt >= CHAT_TOTAL_TIMEOUT_MS[depth]) {
                failWith("模型这轮太慢了，已停止。可以调浅思考或稍后重试。");
              }
              return;
            }
            const verdict = shouldAbortStream({ startedAt, lastActivityAt, now, depth });
            if (verdict.abort) failWith(verdict.reason);
          }, 1_000);
          const vitals = injectVitals ? buildChatVitalsContext() : null;
          const payload = {
            requestId,
            baseUrl: chatConfig.baseUrl,
            model: chatConfig.model,
            apiKey: chatConfig.apiKey.trim() || null,
            message,
            // 自我状态 + 近期互动作为 system 上下文注入（不进用户消息；无状态时整段省略）。
            history: vitals ? [{ role: "system", content: vitals }, ...historyTurns] : historyTurns,
            character,
            images: images.length > 0 ? images : null,
            settings: {
              // 思考预算会吃 token：至少给「预算 + 256」，避免只有思考没有正文。
              maxTokens: chatMaxTokens(chatConfig.maxTokens, depth),
              temperature: chatConfig.temperature,
              topP: chatConfig.topP,
              enableThinking: depth !== "off",
              reasoningEffort: thinkingEffort(depth),
              reasoningBudgetTokens: thinkingBudget(depth),
            },
          };
          const reply = chatConfig.stream
            ? await Promise.race([invoke<string>("local_chat_stream", payload), guard])
            : await Promise.race([
                invoke<string>("local_chat", {
                  baseUrl: payload.baseUrl,
                  model: payload.model,
                  apiKey: payload.apiKey,
                  message: payload.message,
                  history: payload.history,
                  character: payload.character,
                  images: payload.images,
                }),
                guard,
              ]);
          if (active.cancelled) throw new Error("已停止生成。");
          if (!reply || !reply.trim()) {
            throw new Error("模型没有返回正文，请重试或把「思考」调浅。");
          }
          return reply;
        } finally {
          if (watchdog !== null) window.clearInterval(watchdog);
          unlisten?.();
          if (activeRequestRef.current === active) activeRequestRef.current = null;
        }
      };

      const injected = Boolean(buildChatVitalsContext());
      try {
        return await runAttempt(injected);
      } catch (error) {
        if (injected && isTemplateRejection(error)) {
          // 模型模板不接受 system 消息：去掉状态上下文重试一次，而不是让整条消息失败。
          console.warn("[chat] template rejected vitals context, retrying without it", error);
          setStreamingReply("");
          setStreamingReasoning("");
          return await runAttempt(false);
        }
        throw error;
      }
    },
    [
      character,
      chatConfig.apiKey,
      chatConfig.baseUrl,
      chatConfig.maxTokens,
      chatConfig.model,
      chatConfig.stream,
      chatConfig.temperature,
      chatConfig.thinkingDepth,
      chatConfig.topP,
    ],
  );  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    const sendImages = attachments.map((item) => item.send);
    const thumbnails = attachments.map((item) => item.thumb);
    if ((!text && sendImages.length === 0) || busy) return;
    if (!isTauri()) {
      setError(t.chat.desktopOnly);
      return;
    }
    if (chatConfig.backend === "local" && !chatConfig.model.trim()) {
      setError(t.chat.modelNotConfigured);
      setShowModelSettings(true);
      return;
    }
    // 本地模型默认留空，没填地址时先引导去设置，别把 Rust 侧的地址报错直接甩给用户。
    if (chatConfig.backend === "local" && !chatConfig.baseUrl.trim()) {
      setError(t.chat.modelBaseUrlMissing);
      setShowModelSettings(true);
      return;
    }
    if (chatConfig.backend === "dsh" && sendImages.length > 0) {
      setError(t.chat.multimodalLocalOnly);
      return;
    }
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      text,
      at: Date.now(),
      imageCount: thumbnails.length > 0 ? thumbnails.length : undefined,
      thumbnails: thumbnails.length > 0 ? thumbnails : undefined,
    };
    const next = [...messages, userMessage];
    persist(next);
    setDraft("");
    setAttachments([]);
    setError(null);
    setBusy(true);
    setStreamingReply("");
    setStreamingReasoning("");
    setFailedPrompt(null);
    markChatBusy(window.localStorage);
    try {
      let replyText: string | undefined;
      // 「动手」流程：先让模型判断要不要调用本机技能。
      // 关键是这一步必须“短”：只给紧凑的技能清单、关思考、限 96 token，
      // 判断完再走正常的流式回复。之前把完整聊天历史 + 长提示词都塞进去，
      // 每句话都要等两轮完整生成才开始出字，看起来就是「回话很慢」。
      // 「动手」流程：只有像指令的话才先做技能判断，闲聊直接回复。
      // 之前每条消息都先跑一轮完整模型判断，DSH 又是「进程结束才出字」，
      // 相当于每次聊天都要白等一轮，看起来就是卡死。
      const SKILL_HINT =
        /开始|暂停|计时|待办|记一下|日记|播放|音乐|下一首|上一首|打开|启动|换成|换形象|查一下|查资料|搜索|搜一下|联网|几点|剪贴板/;
      const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
        Promise.race([
          promise.catch(() => null),
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
        ]);
      if (agentEnabled && sendImages.length === 0 && SKILL_HINT.test(text)) {
        const askAgent = async (prompt: string, maxTokens: number, temperature: number) => {
          if (chatConfig.backend === "local") {
            return askModel(prompt, [], null, { maxTokens, temperature });
          }
          const reply = await invoke<DshChatReply>("dsh_chat", {
            message: prompt,
            sessionId: null,
            character,
            requestId: null,
          });
          return reply.text;
        };
        // 技能判断最多等 20 秒，超时/失败都退回普通聊天，绝不挡住回复。
        const decision =
          (await withTimeout(
            askAgent(`${skillsPrompt(enabledSkills, customSkills)}\n\n主人说：${text}`, 128, 0.1),
            20_000,
          )) ?? "";
        const call = parseSkillCall(decision);
        if (call) {
          const result = await runSkill(call.action, call.args);
          const toolNote = result.ok ? result.message : `没做成：${result.message}`;
          const summary =
            (await withTimeout(
              askAgent(
                `主人说：${text}\n你刚才执行的动作结果：${result.message}\n请用简洁中文回答主人；如果结果里有搜索资料，就根据资料直接回答，不要输出 JSON。`,
                400,
                0.7,
              ),
              25_000,
            )) ?? "";
          replyText = (summary || result.message).trim();
          persist([
            ...next,
            {
              id: createId(),
              role: "assistant",
              text: replyText,
              at: Date.now(),
              toolNote,
            },
          ]);
          setStreamingReply("");
          setBusy(false);
          return;
        }
      }
      if (chatConfig.backend === "local") {
        replyText = await streamLocalReply(text, messages, sendImages);
      } else {
        // DSH 也走流式：Rust 边读 dsh 输出边推 dsh-chat-stream，
        // 不用等整个进程结束才看到字。
        const requestId = `dsh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let streamed = "";
        const unlisten = await listen<{ requestId: string; text: string }>(
          "dsh-chat-stream",
          (event) => {
            if (event.payload.requestId !== requestId) return;
            streamed += event.payload.text;
            setStreamingReply(streamed);
          },
        );
        try {
          // DSH 同样要有总时长上限，避免命令/事件挂住导致永久 busy。
          const dshGuard = new Promise<never>((_, reject) => {
            window.setTimeout(
              () => reject(new Error("模型没响应，已停止。")),
              chatTimeouts(chatConfig.thinkingDepth).totalMs,
            );
          });
          const reply = await Promise.race([
            invoke<DshChatReply>("dsh_chat", {
              message: text,
              sessionId,
              character,
              requestId,
            }),
            dshGuard,
          ]);
          if (reply.sessionId) {
            setSessionId(reply.sessionId);
            window.localStorage.setItem(SESSION_KEY, reply.sessionId);
          }
          replyText = reply.text;
        } finally {
          unlisten();
        }
      }
      if (!shouldPersistReply(replyText, false)) {
        throw new Error("模型没有返回正文，请重试或把「思考」调浅。");
      }
      const reasoningText = streamingReasoning.trim().slice(0, 4000);
      persist([
        ...next,
        {
          id: createId(),
          role: "assistant",
          text: replyText,
          at: Date.now(),
          reasoning: reasoningText ? reasoningText : undefined,
        },
      ]);
      setStreamingReply("");
      setStreamingReasoning("");
    } catch (reason) {
      const info = describeChatError(reason);
      // 完整错误对象（含 code/raw）打到 console，方便下次直接从控制台取证。
      console.error("[chat] error", { code: info.code, raw: info.raw, error: reason });
      const message = info.message;
      setError(message);
      // 失败/取消时不要把思考内容当答案留在界面上。
      setStreamingReply("");
      setStreamingReasoning("");
      setFailedPrompt(message.includes("已停止") ? null : text || null);
    } finally {
      clearChatBusy(window.localStorage);
      setBusy(false);
    }
  }, [
    busy,
    chatConfig.apiKey,
    chatConfig.backend,
    chatConfig.baseUrl,
    chatConfig.thinkingDepth,
    chatConfig.maxTokens,
    chatConfig.model,
    chatConfig.stream,
    chatConfig.temperature,
    chatConfig.topP,
    character,
    attachments,
    draft,
    messages,
    persist,
    sessionId,
    t.chat.desktopOnly,
    t.chat.modelNotConfigured,
    t.chat.multimodalLocalOnly,
  ]);
  /** 「停止生成」：标记取消、通知 Rust 断开连接并立刻复位界面。 */
  const stopGeneration = useCallback(() => {
    const active = activeRequestRef.current;
    if (active) {
      active.cancelled = true;
      void invoke("local_chat_cancel", { requestId: active.requestId }).catch(() => undefined);
    }
    setBusy(false);
    setWaitSeconds(0);
    setStreamingReply("");
    setStreamingReasoning("");
    setError("已停止生成。");
    clearChatBusy(window.localStorage);
  }, []);
  /** 失败后一键重试同一条提问。 */
  const retryFailed = useCallback(() => {
    if (!failedPrompt || busy) return;
    setError(null);
    setDraft("");
    void send(failedPrompt);
  }, [busy, failedPrompt, send]);

  const clear = useCallback(() => {
    persist([]);
    setSessionId(null);
    setAttachments([]);
    setStreamingReply("");
    setError(null);
    window.localStorage.removeItem(SESSION_KEY);
  }, [persist]);

  return (
    <section className="pet-chat" aria-label={t.chat.title}>
      <header className="pet-chat__header">
        <div className="pet-chat__heading">
          <img
            className="pet-chat__avatar pet-chat__avatar--header"
            src={avatarSrc}
            alt={avatarName}
            title={avatarName}
            draggable={false}
          />
          <div>
            <strong>{t.chat.title}</strong>
            <small>
              {busy
                ? t.chat.thinking
                : chatConfig.backend === "local"
                  ? t.chat.modelBadgeLocal(chatConfig.model)
                  : t.chat.hint}
            </small>
          </div>
        </div>
        <div className="pet-chat__header-actions">

          <button
            className={`pet-chat__model-toggle${agentEnabled ? " is-active" : ""}`}
            type="button"
            title={agentEnabled ? "动手模式：开（点一下关闭）" : "动手模式：关（点一下开启）"}
            aria-label="动手模式"
            aria-pressed={agentEnabled}
            onClick={() => {
              const nextValue = !agentEnabled;
              setAgentEnabled(nextValue);
              try {
                window.localStorage.setItem("maltese-agent-mode", nextValue ? "on" : "off");
              } catch {
                // 忽略
              }
            }}
          >
            <Hand size={15} strokeWidth={1.8} />
          </button>
          <button
            className={`pet-chat__model-toggle${showSkills ? " is-active" : ""}`}
            type="button"
            title="技能"
            aria-label="技能"
            aria-expanded={showSkills}
            onClick={() => setShowSkills((open) => !open)}
          >
            <Wrench size={15} strokeWidth={1.8} />
          </button>
          <button
            className={`pet-chat__model-toggle${showModelSettings ? " is-active" : ""}`}
            type="button"
            title={t.chat.modelSettings}
            aria-label={t.chat.modelSettings}
            aria-expanded={showModelSettings}
            onClick={() => setShowModelSettings((open) => !open)}
          >
            <Settings2 size={15} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            type="button"
            title={t.chat.clear}
            aria-label={t.chat.clear}
            disabled={busy || messages.length === 0}
            onClick={clear}
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {/* 小狗状态条：一行紧凑显示体力/情绪/亲密/专注；无数据时整行不渲染。 */}
      <PetStateBar busy={busy} waitSeconds={waitSeconds} thinkingOn={thinkingOn} />

      {showModelSettings && (
        <LocalChatSettings onClose={() => setShowModelSettings(false)} />
      )}
      {showSkills && (
        <div className="pet-chat__skills">
          <PetSkillsSettings />
        </div>
      )}

      <div className="pet-chat__list" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="pet-chat__empty">
            <img
              className="pet-chat__avatar pet-chat__avatar--empty"
              src={avatarSrc}
              alt={avatarName}
              draggable={false}
            />
            <p>{t.chat.empty}</p>
            <small>{t.chat.emptyHint}</small>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`pet-chat__row pet-chat__row--${message.role}`}
          >
            {message.role === "assistant" && (
              <img
                className="pet-chat__avatar"
                src={avatarSrc}
                alt={avatarName}
                title={avatarName}
                draggable={false}
              />
            )}
            <div
              className={`pet-chat__bubble pet-chat__bubble--${message.role}`}
            >
              {message.thumbnails && message.thumbnails.length > 0 && (
                <div className="pet-chat__thumbs">
                  {message.thumbnails.map((thumb, index) => (
                    <img key={index} src={thumb} alt={t.chat.imageAttached(index + 1)} />
                  ))}
                </div>
              )}
              {showThinking && message.reasoning ? (
                <ChatReasoning text={message.reasoning} />
              ) : null}
              {message.text && <ChatText text={message.text} />}
              {message.toolNote ? (
                <small className="pet-chat__tool-note">{message.toolNote}</small>
              ) : null}
              <div className="pet-chat__meta">
                <time dateTime={new Date(message.at).toISOString()}>
                  {new Date(message.at).toLocaleTimeString(t.localeTag, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <button
                  type="button"
                  className="pet-chat__copy"
                  title="复制这条消息"
                  aria-label="复制这条消息"
                  onClick={() => {
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(message.text);
                      } catch {
                        await invoke("set_clipboard_text", { text: message.text }).catch(() => undefined);
                      }
                    })();
                  }}
                >
                  <Copy size={11} strokeWidth={2} />
                </button>
              </div>
            </div>
          </div>
        ))}
        {busy && (streamingReasoning || streamingReply) && (
          <div className="pet-chat__row pet-chat__row--assistant">
            <img
              className="pet-chat__avatar"
              src={avatarSrc}
              alt={avatarName}
              title={avatarName}
              draggable={false}
            />
            <div className="pet-chat__bubble pet-chat__bubble--assistant">
              {showThinking && streamingReasoning ? (
                <ChatReasoning text={streamingReasoning} streaming />
              ) : null}
              {streamingReply ? <ChatText text={streamingReply} /> : null}
            </div>
          </div>
        )}
        {busy && (
          <div className="pet-chat__row pet-chat__row--assistant">
            <img
              className="pet-chat__avatar"
              src={avatarSrc}
              alt={avatarName}
              title={avatarName}
              draggable={false}
            />
            <div className="pet-chat__bubble pet-chat__bubble--assistant pet-chat__bubble--typing" role="status">
              <LoaderCircle size={15} className="pet-chat__spin" />
              <span>
                {waitSeconds >= 3
                  ? `小狗在加载模型或思考，稍等（${waitSeconds}s）`
                  : thinkingOn
                    ? "小狗正在思考…"
                    : t.chat.thinking}
                {waitSeconds >= 1 && waitSeconds < 3 ? `（${waitSeconds}s）` : ""}
              </span>
              <button
                type="button"
                className="pet-chat__stop"
                title="停止生成"
                aria-label="停止生成"
                onClick={stopGeneration}
              >
                <Square size={11} strokeWidth={2.4} />
                停止
              </button>
            </div>
          </div>
        )}
        {busy && thinkingOn && waitSeconds >= 3 && !streamingReasoning && (
          <p className="pet-chat__hint">
            思考深度：{thinkingLabel}，模型在推理；深度越大首字越慢，可在设置里调到「关」或「浅」加快回复。
          </p>
        )}
        {/* 状态阈值跨越的灰色小字：不写进消息、不发给模型 */}
        {stateNotices.map((notice, index) => (
          <p key={`${notice}-${index}`} className="pet-chat__state-notice">
            {notice}
          </p>
        ))}
      </div>

      {error && (
        <p className="pet-chat__error" role="alert">
          <span>{error}</span>
          {failedPrompt && !busy && (
            <button type="button" className="pet-chat__retry" onClick={retryFailed}>
              <RotateCcw size={12} strokeWidth={2.2} />
              重试
            </button>
          )}
        </p>
      )}

      {attachments.length > 0 && (
        <div className="pet-chat__attachments">
          {attachments.map((item, index) => (
            <div className="pet-chat__attachment" key={index}>
              <img src={item.thumb} alt={t.chat.imageAttached(index + 1)} />
              <button
                type="button"
                title={t.chat.imageRemove}
                aria-label={t.chat.imageRemove}
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="pet-chat__composer">
        <label className="pet-chat__attach" title={t.chat.imageAttach} aria-label={t.chat.imageAttach}>
          <ImagePlus size={16} strokeWidth={1.9} />
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              void addImages(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        </label>
        <textarea
          value={draft}
          rows={2}
          maxLength={4000}
          placeholder={t.chat.placeholder}
          aria-label={t.chat.placeholder}
          disabled={busy}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onPaste={(event) => {
            // 直接 Ctrl+V 粘贴截图 / 复制的图片，不用先存成文件。
            const items = Array.from(event.clipboardData?.items ?? []);
            const files = items
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (files.length > 0) {
              event.preventDefault();
              void addImages(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="pet-chat__send"
          type="button"
          disabled={busy || (!draft.trim() && attachments.length === 0)}
          title={t.chat.send}
          aria-label={t.chat.send}
          onClick={() => void send()}
        >
          <Send size={16} strokeWidth={2} />
        </button>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "./i18n";
import {
  loadCustomSkills,
  loadEnabledSkills,
  parseSkillCall,
  runSkill,
  skillsPrompt,
} from "./petSkills";
import { usePetCharacter, PET_CHARACTER_LABELS } from "./petCharacters";
import { maybeInferTaskProgress } from "./taskProgressInference";
import { PET_CHARACTER_ASSETS } from "./petCharacterAssets.generated";
import { petAssetUrl } from "./petAssetBase";
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
  isQueueing,
  isTemplateRejection,
  markChatBusy,
  shouldAbortStream,
  shouldPersistReply,
} from "./chatGuard";
import { buildChatVitalsContext, loadVitalsSummary } from "./petContext";
import { RECENT_TURNS, buildMemoryContext, loadMemory, loadMemoryDepth } from "./petMemory";
import {
  isStickerId,
  splitAssistantReply,
  STICKER_IDS,
  stickerPoolOrder,
  stripStickerMarkup,
  type StickerId,
} from "./chatSticker";
import { pickStickerForVitals } from "./petVitals";
import type { ChatMessage, DshChatReply, LocalChatStreamEvent } from "./petChatTypes";
import { PetChatView } from "./PetChatView";
import {
  createId,
  fileToDataUrl,
  loadMessages,
  MAX_IMAGES,
  MAX_MESSAGES,
  MESSAGES_KEY,
  SEND_IMAGE_MAX_SIDE,
  SESSION_KEY,
  THUMB_IMAGE_MAX_SIDE,
} from "./petChatStorage";
import { usePetChatStateNotices } from "./usePetChatStateNotices";
import "./PetChat.css";

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
  // 打开聊天就后台预热本地模型：Strata 端口在跑但模型可能还是 unloaded，
  // 第一个请求会长时间没有 SSE 事件（用户看到「完全没回复」）。
  useEffect(() => {
    if (!isTauri() || chatConfig.backend !== "local" || !chatConfig.baseUrl.trim()) return;
    const timer = window.setTimeout(() => {
      void invoke<boolean>("ensure_local_model", {
        baseUrl: chatConfig.baseUrl,
        model: chatConfig.model,
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [chatConfig.backend, chatConfig.baseUrl, chatConfig.model]);
  /** 正在进行的流式请求：用于「停止生成」和防止旧请求回写。 */
  const activeRequestRef = useRef<{ requestId: string; cancelled: boolean } | null>(null);
  /** 用户在「加载模型」阶段点了停止（此时还没有真正的流式请求）。 */
  const cancelRef = useRef(false);
  /** 本次模型预热的取消 token（Rust 侧每 2s 检查）。 */
  const loadTokenRef = useRef<string | null>(null);
  /** 最近一次失败的提问：给「重试」按钮用。 */
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);
  /** 首字是否已经到达（分级超时用）。 */
  const firstDeltaRef = useRef(false);
  // 聊天里的「小狗状态条」+ 阈值跨越灰色提示（只展示，不写记录、不发给模型）。
  const stateNotices = usePetChatStateNotices(character);
  /** 正在加载本地模型（预热）：用来把 busy 文案从「思考」换成「加载模型…」。 */
  const [modelLoading, setModelLoading] = useState(false);
  /** 单槽位排队中（后端 processing=true 且我们还没收到任何事件）。 */
  const [queueing, setQueueing] = useState(false);
  /** 客户端发送队列：忙时连发的消息先排队，等当前回答完再自动发。 */
  const [sendQueue, setSendQueue] = useState<string[]>([]);
  const sendRef = useRef<((overrideText?: string) => Promise<void>) | null>(null);
  /** 点击放大的表情包预览（null 表示没有）。 */
  const [stickerPreview, setStickerPreview] = useState<string | null>(null);
  /** 内联表情包显示宽度（默认 150，onLoad 按自然尺寸修正）。 */
  const [stickerWidth, setStickerWidth] = useState(150);
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
      options?: { maxTokens?: number; temperature?: number; source?: string },
    ) => {
      if (chatConfig.backend === "dsh") {
        const reply = await invoke<DshChatReply>("dsh_chat", {
          message,
          sessionId,
          character,
          memoryContext: buildMemoryContext(loadMemory(), loadMemoryDepth(), Date.now(), message),
          source: options?.source ?? "chat",
          sticker: false,
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
          const ready = await invoke<boolean>("ensure_local_model", { baseUrl: chatConfig.baseUrl, model: chatConfig.model });
          return Boolean(ready);
        } catch {
          return false;
        }
      };
      try {
        return await invoke<string>("local_chat_stream", {
          requestId: createId(),
          source: options?.source ?? "chat",
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-RECENT_TURNS).map((item) => ({ role: item.role, content: item.text })),
          character,
          sticker: false,
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
                source: options?.source ?? "chat",
                baseUrl: chatConfig.baseUrl,
                model: chatConfig.model,
                apiKey: chatConfig.apiKey.trim() || null,
                message,
                history: history.slice(-RECENT_TURNS).map((item) => ({ role: item.role, content: item.text })),
                character,
                sticker: false,
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
          source: options?.source ?? "chat",
          baseUrl: chatConfig.baseUrl,
          model: chatConfig.model,
          apiKey: chatConfig.apiKey.trim() || null,
          message,
          history: history.slice(-RECENT_TURNS).map((item) => ({ role: item.role, content: item.text })),
          character,
          sticker: false,
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
  /** 表情包 id → 素材 GIF 地址：微博 stickers 池（部分 id）→ 当前角色 → duo 回退 shared→xiaobai。
   * 缺素材/异常返回 null（静默忽略，绝不显示破图）。 */
  const stickerUrl = (id: StickerId | null | undefined): string | null => {
    if (!id) return null;
    try {
      for (const pool of stickerPoolOrder(id, character)) {
        const frames = PET_CHARACTER_ASSETS[pool.group]?.[pool.action] ?? [];
        const first = frames[0];
        if (first) return petAssetUrl(first);
      }
      return null;
    } catch {
      return null;
    }
  };

  // 带界面的流式回复：边生成边把字显示出来，并把最终文本返回给调用方。
  // 超时策略（实测修正）：用「空闲 watchdog」而不是固定首字 8s —— 本机首次 prefill 可到
  // 16–55s；只要还有事件就不算卡死；一旦开始输出，只看 20s 空窗与 120s 总时长。
  // 模板不兼容自动降级：注入状态上下文被 400 拒绝时，去掉注入重试一次，不让整条消息失败。
  const streamLocalReply = useCallback(
    async (message: string, history: ChatMessage[], images: string[]) => {
      const depth = chatConfig.thinkingDepth;
      const historyTurns = history.slice(-RECENT_TURNS).map((item) => ({ role: item.role, content: item.text }));

      const runAttempt = async (injectVitals: boolean, useStream = chatConfig.stream): Promise<string> => {
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
        let lastStatusAt = 0;
        const unlisten = useStream
          ? await listen<LocalChatStreamEvent>("local-chat-stream", (event) => {
            if (event.payload.requestId !== requestId || active.cancelled) return;
            // 任何事件都算「还活着」：思考流也算，避免思考档位被首字超时误杀。
            lastActivityAt = Date.now();
            if (event.payload.kind === "delta") {
              firstDeltaRef.current = true;
              setStreamingReply((current) => stripStickerMarkup(current + event.payload.text));
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
            if (!useStream) {
              // 非流式没有中间事件，只按总时长兜底。
              if (now - startedAt >= CHAT_TOTAL_TIMEOUT_MS[depth]) {
                failWith("模型这轮太慢了，已停止。可以调浅思考或稍后重试。");
              }
              return;
            }
            const verdict = shouldAbortStream({ startedAt, lastActivityAt, now, depth });
            if (verdict.abort) failWith(verdict.reason);
            // 还没有任何事件：查后端单槽位是否在忙（/slots is_processing）→ 显示「排队中…」，
            // 排队不中止（排队上限 240s，见 shouldAbortStream）。
            if (lastActivityAt !== null) {
              if (queueing) setQueueing(false);
            } else if (
              isQueueing({ startedAt, lastActivityAt, now, depth })
              && now - lastStatusAt >= 3_000
            ) {
              lastStatusAt = now;
              void invoke<{ loaded: boolean; processing: boolean }>('local_model_status', {
                baseUrl: chatConfig.baseUrl,
              })
                .then((status) => setQueueing(Boolean(status?.processing)))
                .catch(() => setQueueing(true));
            }
          }, 1_000);
          const vitals = injectVitals ? buildChatVitalsContext() : null;
          // 上下文只放状态（贴纸指令由 Rust 侧 persona 注入，模型才真的看得到）。
          const systemContext = vitals ?? "";
          const payload = {
            requestId,
            baseUrl: chatConfig.baseUrl,
            memoryContext: buildMemoryContext(loadMemory(), loadMemoryDepth(), Date.now(), message),
            source: "chat",
            model: chatConfig.model,
            apiKey: chatConfig.apiKey.trim() || null,
            message,
            // 自我状态 + 近期互动作为 system 上下文注入（不进用户消息；无状态时整段省略）。
            history: systemContext
              ? [{ role: "system", content: systemContext }, ...historyTurns]
              : historyTurns,
            // 正常聊天允许模型输出表情包标记；技能判断传 false。
            sticker: true,
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
          const reply = useStream
            ? await Promise.race([invoke<string>("local_chat_stream", payload), guard])
            : await Promise.race([
                invoke<string>("local_chat", {
                  baseUrl: payload.baseUrl,
                  model: payload.model,
                  apiKey: payload.apiKey,
                  message: payload.message,
                  memoryContext: payload.memoryContext,
                  source: payload.source,
                  history: payload.history,
                  character: payload.character,
                  sticker: true,
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
      const isUserStop = (error: unknown): boolean =>
        String(error instanceof Error ? error.message : error).includes("已停止");
      try {
        return await runAttempt(injected, chatConfig.stream);
      } catch (error) {
        if (isUserStop(error)) throw error;
        // 1) 模板拒绝注入：去掉状态上下文再试一次（不让整条消息失败）。
        if (injected && isTemplateRejection(error)) {
          console.warn("[chat] template rejected vitals context, retrying without it", error);
          setStreamingReply("");
          setStreamingReasoning("");
          try {
            return await runAttempt(false, chatConfig.stream);
          } catch (retryError) {
            if (isUserStop(retryError)) throw retryError;
            console.warn("[chat] streaming retry failed, falling back to non-stream", retryError);
          }
        } else {
          console.warn("[chat] streaming attempt failed, falling back to non-stream", error);
        }
        // 2) 最后兜底：退回非流式也要有正文（关思考、不注入状态）。
        setStreamingReply("");
        setStreamingReasoning("");
        return await runAttempt(false, false);
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
    if (!text && sendImages.length === 0) return;
    if (busy) {
      // 连发：当前回答还没结束，先把这条排进本地队列，等前面的完成再自动发送。
      setSendQueue((current) => [...current, text]);
      setDraft("");
      setAttachments([]);
      return;
    }
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
    cancelRef.current = false;
    setQueueing(false);
    try {
      // 本地模型：发送前确认「端口在跑 + 模型已加载」。冷启动可能要 1–2 分钟，
      // 期间 busy 文案会显示加载中；加载失败/超时给中文原因，不让请求静默挂着。
      if (chatConfig.backend === "local") {
        setModelLoading(true);
        const loadToken = createId();
        loadTokenRef.current = loadToken;
        let ready = false;
        try {
          ready = await Promise.race([
            invoke<boolean>("ensure_local_model", {
              baseUrl: chatConfig.baseUrl,
              model: chatConfig.model,
              cancelToken: loadToken,
            }).catch(() => false),
            new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 240_000)),
          ]);
        } finally {
          setModelLoading(false);
          loadTokenRef.current = null;
        }
        if (cancelRef.current || activeRequestRef.current?.cancelled) throw new Error("已停止生成。");
        if (!ready) {
          throw new Error("模型没能加载：请检查 Strata 是否在运行、显存是否够（首次加载约 1–4 分钟）。");
        }
      }
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
      // 命中技能时由技能自己上报确定性任务，不再跑兜底模型推断。
      let skillHandled = false;
      if (agentEnabled && sendImages.length === 0 && SKILL_HINT.test(text)) {
        const askAgent = async (prompt: string, maxTokens: number, temperature: number, source = "chat") => {
          if (chatConfig.backend === "local") {
            return askModel(prompt, [], null, { maxTokens, temperature, source });
          }
          const reply = await invoke<DshChatReply>("dsh_chat", {
            message: prompt,
            sessionId: null,
            character,
            source,
            requestId: null,
          });
          return reply.text;
        };
        // 技能判断最多等 20 秒，超时/失败都退回普通聊天，绝不挡住回复。
        const decision =
          (await withTimeout(
            askAgent(`${skillsPrompt(enabledSkills, customSkills)}\n\n主人说：${text}`, 128, 0.1, "decision"),
            20_000,
          )) ?? "";
        const call = parseSkillCall(decision);
        if (call) {
          skillHandled = true;
          const result = await runSkill(call.action, call.args);
          const toolNote = result.ok ? result.message : `没做成：${result.message}`;
          const summary =
            (await withTimeout(
              askAgent(
                `主人说：${text}\n你刚才执行的动作结果：${result.message}\n请用简洁中文回答主人；如果结果里有搜索资料，就根据资料直接回答，不要输出 JSON。`,
                400,
                0.7,
                "chat",
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
              source: "chat",
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
      // 表情包信使：抽受控标记 → 校验白名单 → 最近 3 条去重；非法标记会被移除且不显示。
      const recentStickers = messages
        .filter((item) => item.role === "assistant" && item.sticker)
        .slice(-3)
        .map((item) => item.sticker);
      const split = splitAssistantReply(replyText ?? "", recentStickers);
      const finalText = split.text;
      let sticker = split.sticker;
      // 模型没给标记时的兜底（只在明确场景补，避免自说自话）：体力低 → 按 vitals 权重补一个安静表情。
      if (!sticker) {
        const vitals = loadVitalsSummary();
        if (vitals && vitals.energy < 35) {
          const picked = pickStickerForVitals(
            { ...vitals, focus: vitals.focus ?? 0 },
            STICKER_IDS,
            { avoid: recentStickers.filter(Boolean) as string[] },
          );
          if (isStickerId(picked)) sticker = picked;
        }
      }
      // 调试证据：保留模型原文末尾，便于确认标记确实来自模型（不含整段聊天正文）。
      try {
        const previous = JSON.parse(window.localStorage.getItem("maltese-chat-sticker-debug") ?? "[]");
        const entries = Array.isArray(previous) ? previous.slice(-9) : [];
        entries.push({
          at: Date.now(),
          sticker: sticker ?? null,
          rawTail: (replyText ?? "").slice(-80),
        });
        window.localStorage.setItem("maltese-chat-sticker-debug", JSON.stringify(entries));
      } catch {
        // 忽略
      }
      // 文字为空但模型只给了表情包：只产生 sticker 消息；文字和表情包都空才算失败。
      if (!shouldPersistReply(finalText, false) && !sticker) {
        throw new Error("模型没有返回正文，请重试或把「思考」调浅。");
      }
      const at = Date.now();
      const appended: ChatMessage[] = [];
      if (finalText) {
        appended.push({
          id: createId(),
          role: "assistant",
          kind: "text",
          text: finalText,
          at,
          reasoning: reasoningText ? reasoningText : undefined,
        });
      }
      if (sticker) {
        // 表情包单独一条消息，紧跟在文字之后（顺序稳定：文字 → 表情包）。
        appended.push({
          id: createId(),
          role: "assistant",
          kind: "sticker",
          text: "",
          at: at + 1,
          sticker,
        });
      }
      persist([...next, ...appended]);
      if (!skillHandled) {
        // 兜底：未命中技能时才异步分类（≤100 token，不阻塞首字，不覆盖确定性状态）。
        void maybeInferTaskProgress(text, replyText ?? "");
      }
      setStreamingReply("");
      setStreamingReasoning("");
    } catch (reason) {
      const info = describeChatError(reason);
      // 完整错误对象（含 code/raw）打到 console，方便下次直接从控制台取证。
      console.error("[chat] error", { code: info.code, raw: info.raw, error: reason });
      // 持久化最后一次错误，方便用户反馈时直接取证（不含聊天正文）。
      try {
        window.localStorage.setItem("maltese-chat-last-error", JSON.stringify({ code: info.code, raw: info.raw.slice(0, 500), at: Date.now() }));
      } catch {
        // 忽略
      }
      const message = info.message;
      setError(message);
      // 失败/取消时不要把思考内容当答案留在界面上。
      setStreamingReply("");
      setStreamingReasoning("");
      setFailedPrompt(message.includes("已停止") ? null : text || null);
    } finally {
      clearChatBusy(window.localStorage);
      setBusy(false);
      // 队列里还有就自动发下一条（忙时连发的消息不会丢）。
      setSendQueue((current) => {
        if (current.length === 0) return current;
        const [next, ...rest] = current;
        window.setTimeout(() => {
          void sendRef.current?.(next);
        }, 30);
        return rest;
      });
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
  // 放大预览：Esc 也能关（点任意处关闭由遮罩按钮负责）。
  useEffect(() => {
    if (!stickerPreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStickerPreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stickerPreview]);

  sendRef.current = send;

  /** 「停止生成」：标记取消、通知 Rust 断开连接并立刻复位界面。 */
  const stopGeneration = useCallback(() => {
    cancelRef.current = true;
    const active = activeRequestRef.current;
    if (active) {
      active.cancelled = true;
      void invoke("local_chat_cancel", { requestId: active.requestId }).catch(() => undefined);
    }
    setModelLoading(false);
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
    <PetChatView
      t={t}
      avatarSrc={avatarSrc}
      avatarName={avatarName}
      busy={busy}
      chatConfig={chatConfig}
      agentEnabled={agentEnabled}
      setAgentEnabled={setAgentEnabled}
      showSkills={showSkills}
      setShowSkills={setShowSkills}
      showModelSettings={showModelSettings}
      setShowModelSettings={setShowModelSettings}
      messages={messages}
      clear={clear}
      thinkingOn={thinkingOn}
      waitSeconds={waitSeconds}
      showThinking={showThinking}
      listRef={listRef}
      stickerUrl={stickerUrl}
      stickerWidth={stickerWidth}
      setStickerWidth={setStickerWidth}
      setStickerPreview={setStickerPreview}
      streamingReasoning={streamingReasoning}
      streamingReply={streamingReply}
      modelLoading={modelLoading}
      sendQueue={sendQueue}
      queueing={queueing}
      thinkingLabel={thinkingLabel}
      stopGeneration={stopGeneration}
      stateNotices={stateNotices}
      error={error}
      failedPrompt={failedPrompt}
      retryFailed={retryFailed}
      attachments={attachments}
      setAttachments={setAttachments}
      addImages={addImages}
      draft={draft}
      setDraft={setDraft}
      send={send}
      stickerPreview={stickerPreview}
    />
  );
}

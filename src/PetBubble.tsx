import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import "./PetBubble.css";

type BubblePayload = {
  mode: "hover" | "cloud" | "menu";
  title?: string | null;
  body?: string | null;
  ttlMs?: number | null;
};

type MediaSummary = {
  playbackStatus?: string;
  title?: string | null;
  artist?: string | null;
};

const TODOS_KEY = "focusd-island-todos";

// 小狗侧边的气泡窗口：hover 时浮出互动面板，收到消息/动作时浮出云朵文字框。
export default function PetBubble() {
  const [payload, setPayload] = useState<BubblePayload | null>(null);
  const [todoLeft, setTodoLeft] = useState<number | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const hideTimer = useRef<number | null>(null);

  const reportHover = useCallback((hovered: boolean) => {
    void emit("maltese-bubble-hover", { hovered });
  }, []);

  const applyPayload = useCallback((next: BubblePayload | null) => {
      if (!next) {
        return;
      }
      setPayload(next);
      try {
        const color = window.localStorage.getItem("maltese-bubble-color");
        if (color) {
          document.documentElement.style.setProperty("--pet-bubble-text", color);
        }
      } catch {
        // 忽略读取失败
      }
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (next.mode === "cloud") {
        // 云朵气泡按设置时长自动收起。
        const ttl = typeof next.ttlMs === "number" && next.ttlMs > 0 ? next.ttlMs : 6000;
        hideTimer.current = window.setTimeout(() => {
          void invoke("hide_pet_bubble").catch(() => undefined);
        }, ttl);
        return;
      }
      // hover 面板：拉取状态摘要。
      try {
        const raw = window.localStorage.getItem(TODOS_KEY);
        const todos = raw ? (JSON.parse(raw) as Array<{ completed?: boolean }>) : [];
        setTodoLeft(todos.filter((todo) => !todo.completed).length);
      } catch {
        setTodoLeft(null);
      }
      void invoke<MediaSummary>("get_media_state", { target: null })
        .then((state) => {
          if (state.playbackStatus === "playing") {
            setNowPlaying([state.title, state.artist].filter(Boolean).join(" - ") || null);
          } else {
            setNowPlaying(null);
          }
        })
        .catch(() => setNowPlaying(null));
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // 先补取一次缓存内容，避免气泡窗口冷启动时丢掉早到的事件。
    void invoke<BubblePayload | null>("get_pet_bubble_payload")
      .then((cached) => {
        if (!disposed) applyPayload(cached);
      })
      .catch(() => undefined);
    void listen<BubblePayload>("pet-bubble-content", (event) => {
      if (disposed) {
        return;
      }
      applyPayload(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [applyPayload]);

  const petAction = (action: string) => {
    void emit("maltese-pet-action", { action });
    void invoke("hide_pet_bubble").catch(() => undefined);
  };
  const openPage = (page: string) => {
    void emit("maltese-open-page", { page });
  };

  return (
    <div
      className="pet-bubble-stage"
      onMouseEnter={() => reportHover(true)}
      onMouseLeave={() => reportHover(false)}
    >
      {payload?.mode === "menu" ? (
        <div className="pet-cloud pet-bubble-menu" role="menu">
          <button
            type="button"
            onClick={() => {
              void invoke("open_settings_window").catch(() => openPage("layout"));
              void invoke("hide_pet_bubble").catch(() => undefined);
            }}
          >
            配置桌宠
          </button>
          <button type="button" onClick={() => openPage("assistant")}>快捷入口</button>
          <button type="button" onClick={() => petAction("sleeping")}>让小狗睡觉</button>
          <button
            type="button"
            onClick={() => {
              void emit("maltese-pet-hide");
            }}
          >
            隐藏到托盘
          </button>
        </div>
      ) : payload?.mode === "cloud" ? (
        <div className="pet-cloud pet-bubble-cloud" role="status">
          {payload.title && <strong className="pet-bubble-cloud__title">{payload.title}</strong>}
          {payload.body && <p className="pet-bubble-cloud__body">{payload.body}</p>}
          <span className="pet-cloud__tail pet-cloud__tail--1" aria-hidden="true" />
          <span className="pet-cloud__tail pet-cloud__tail--2" aria-hidden="true" />
        </div>
      ) : (
        <div className="pet-cloud pet-bubble-panel">
          <div className="pet-bubble-panel__actions" aria-label="和小狗互动">
            {([
              ["pet", "🐾 摸头"],
              ["chin", "😌 挠下巴"],
              ["pickup", "🤗 抱抱"],
              ["spin", "🌀 转圈"],
              ["play", "🎾 陪玩"],
              ["hide", "🙈 躲猫猫"],
              ["chase", "🏃 追球"],
              ["eating", "🍖 喂食"],
              ["sleeping", "😴 睡觉"],
            ] as const).map(([action, label]) => (
              <button key={action} type="button" onClick={() => petAction(action)}>
                {label}
              </button>
            ))}
          </div>
          <div className="pet-bubble-panel__status">
            {todoLeft !== null && <span>📋 待办还剩 {todoLeft} 个</span>}
            {nowPlaying && <span>🎵 正在播放：{nowPlaying}</span>}
          </div>
          <div className="pet-bubble-panel__links">
            <button type="button" onClick={() => openPage("todo")}>待办</button>
            <button type="button" onClick={() => openPage("music")}>音乐</button>
            <button type="button" onClick={() => openPage("assistant")}>快捷</button>
            <button
              type="button"
              onClick={() => {
                void emit("maltese-pet-minimize");
              }}
            >
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

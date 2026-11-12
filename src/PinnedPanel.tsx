// 固定在桌面上的标签页窗口。
//
// 右键小狗 →「📌 固定当前标签到桌面」后，这个窗口会一直留在桌面上（置顶、不随鼠标离开消失），
// 目前支持把「聊天」标签固定出来；其它标签会提示先切到聊天。
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Pin, PinOff, X } from "lucide-react";
import { PetChat } from "./PetChat";
import "./PinnedPanel.css";

const PAGE_LABELS: Record<string, string> = {
  chat: "聊天",
  todo: "待办",
  music: "音乐",
  plugins: "插件",
  assistant: "快捷入口",
  video: "视频",
  settings: "设置",
};

export default function PinnedPanel() {
  const [page, setPage] = useState<string>(() => {
    try {
      return window.localStorage.getItem("maltese-pinned-page") || "chat";
    } catch {
      return "chat";
    }
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ page?: string }>("maltese-pinned-page", (event) => {
      const next = event.payload?.page || "chat";
      setPage(next);
      try {
        window.localStorage.setItem("maltese-pinned-page", next);
      } catch {
        // 忽略
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  const unpin = () => {
    void invoke("unpin_page_from_desktop").catch(() => undefined);
  };

  const label = PAGE_LABELS[page] ?? page;

  return (
    <div className="pinned-panel">
      <header className="pinned-panel__head" data-tauri-drag-region>
        <span className="pinned-panel__badge" data-tauri-drag-region>
          <Pin size={13} aria-hidden="true" />
          已固定在桌面 · {label}
        </span>
        <div className="pinned-panel__actions">
          <button type="button" className="pinned-panel__btn" onClick={unpin} title="取消固定（回到小狗身上）">
            <PinOff size={13} aria-hidden="true" />
            取消固定
          </button>
          <button
            type="button"
            className="pinned-panel__btn pinned-panel__btn--ghost"
            onClick={() => {
              void invoke("unpin_page_from_desktop").catch(() => undefined);
            }}
            title="关闭这个窗口"
            aria-label="关闭这个窗口"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="pinned-panel__body">
        {page === "chat" ? (
          <PetChat />
        ) : (
          <div className="pinned-panel__empty">
            <p>
              「{label}」标签暂不支持固定在桌面。
            </p>
            <p>先在小狗面板里切到「聊天」，再右键小狗选「固定当前标签到桌面」。</p>
            <button
              type="button"
              className="pinned-panel__btn"
              onClick={() => {
                if (!isTauri()) return;
                void invoke("unpin_page_from_desktop").catch(() => undefined);
              }}
            >
              取消固定
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
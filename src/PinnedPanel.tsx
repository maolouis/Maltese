// 固定在桌面上的标签页窗口。
//
// 右键小狗 → 顶部按钮组里的「📌 固定当前标签」后，这个窗口会一直留在桌面上
//（置顶、不随鼠标离开消失）。支持：聊天 / 待办 / 音乐 / 快捷。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Music, ListTodo, MessageCircle, Grid2x2, PinOff, X } from "lucide-react";
import { PetChat } from "./PetChat";
import { PinnedTodo } from "./PinnedTodo";
import { PinnedMusic } from "./PinnedMusic";
import { AssistantPanel } from "./App";
import "./PinnedPanel.css";

const TABS = [
  { id: "chat", label: "聊天", icon: MessageCircle },
  { id: "todo", label: "待办", icon: ListTodo },
  { id: "music", label: "音乐", icon: Music },
  { id: "assistant", label: "快捷", icon: Grid2x2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTab(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export default function PinnedPanel() {
  const [page, setPage] = useState<TabId>(() => {
    try {
      const saved = window.localStorage.getItem("maltese-pinned-page") || "chat";
      return isTab(saved) ? saved : "chat";
    } catch {
      return "chat";
    }
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ page?: string }>("maltese-pinned-page", (event) => {
      const next = event.payload?.page || "chat";
      if (isTab(next)) setPage(next);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  const selectTab = (next: TabId) => {
    setPage(next);
    try {
      window.localStorage.setItem("maltese-pinned-page", next);
    } catch {
      // 忽略
    }
  };

  const unpin = () => {
    void invoke("unpin_page_from_desktop").catch(() => undefined);
  };

  return (
    <div className="pinned-panel">
      <header className="pinned-panel__head" data-tauri-drag-region>
        <span className="pinned-panel__badge" data-tauri-drag-region>
          📌 已固定在桌面
        </span>
        <div className="pinned-panel__actions">
          <button type="button" className="pinned-panel__btn" onClick={unpin} title="取消固定">
            <PinOff size={13} aria-hidden="true" />
            取消固定
          </button>
          <button
            type="button"
            className="pinned-panel__btn pinned-panel__btn--ghost"
            onClick={unpin}
            title="关闭这个窗口"
            aria-label="关闭这个窗口"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className="pinned-panel__tabs" aria-label="固定窗口的标签页">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              className={`pinned-panel__tab${page === tab.id ? " is-active" : ""}`}
              aria-pressed={page === tab.id}
              onClick={() => selectTab(tab.id)}
            >
              <Icon size={14} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="pinned-panel__body">
        {page === "chat" && <PetChat />}
        {page === "todo" && <PinnedTodo />}
        {page === "music" && <PinnedMusic />}
        {page === "assistant" && <AssistantPanel />}
      </div>
    </div>
  );
}
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import "./ChatReasoning.css";

/**
 * 思考过程面板：默认折叠，点标题展开。
 * 流式思考时会跟着变长，但默认仍然收起，避免刷屏。
 */
export function ChatReasoning({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\n+/).filter(Boolean).length;

  return (
    <div className={`chat-reasoning${open ? " chat-reasoning--open" : ""}`}>
      <button
        type="button"
        className="chat-reasoning__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={13} strokeWidth={2} className="chat-reasoning__chevron" />
        <span>{streaming ? "正在思考…" : "思考过程"}</span>
        <small>{lines > 1 ? `${lines} 行` : `${trimmed.length} 字`}</small>
      </button>
      {open && <pre className="chat-reasoning__body">{trimmed}</pre>}
    </div>
  );
}
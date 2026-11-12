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
  defaultOpen = false,
}: {
  text: string;
  streaming?: boolean;
  /** 流式思考时默认展开，用户能直接看到模型在输出（否则像没反应）。 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
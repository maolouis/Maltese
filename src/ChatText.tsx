import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./ChatText.css";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; block: boolean }
  | { kind: "math"; text: string; display: boolean };

// 支持的行内/块级公式定界符：
//   $$...$$  \[...\]   → 块级
//   $...$    \(...\)   → 行内
// 单个 $ 只有在紧跟非空白、且内容里像公式（含 \ 命令或上下标/运算符）时才当公式，
// 避免把「$5」「$HOME」这类普通文本吃掉。
const INLINE_MATH_COMMAND = /\\[a-zA-Z]+|[\\^_{}]/;

function looksLikeMath(body: string): boolean {
  if (!body.trim()) return false;
  if (body.startsWith(" ")) return false;
  if (body.endsWith(" ")) return false;
  return INLINE_MATH_COMMAND.test(body);
}

function parseSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = "";
  let index = 0;

  const flushText = () => {
    if (buffer) {
      segments.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  const takeDelimited = (open: string, close: string): string | null => {
    if (!source.startsWith(open, index)) return null;
    const end = source.indexOf(close, index + open.length);
    if (end <= index) return null;
    return source.slice(index + open.length, end);
  };

  while (index < source.length) {
    // ``` 代码块 ```
    if (source.startsWith("```", index)) {
      const end = source.indexOf("```", index + 3);
      if (end > index) {
        flushText();
        const body = source.slice(index + 3, end);
        segments.push({ kind: "code", text: body.replace(/^[a-zA-Z0-9_+-]*\n/, ""), block: true });
        index = end + 3;
        continue;
      }
    }
    // 行内代码 `x`
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index) {
        flushText();
        segments.push({ kind: "code", text: source.slice(index + 1, end), block: false });
        index = end + 1;
        continue;
      }
    }
    // 块级公式：$$...$$ / \[...\]
    const blockDollar = takeDelimited("$$", "$$");
    if (blockDollar !== null) {
      flushText();
      segments.push({ kind: "math", text: blockDollar, display: true });
      index += 2 + blockDollar.length + 2;
      continue;
    }
    const blockBracket = takeDelimited("\\[", "\\]");
    if (blockBracket !== null) {
      flushText();
      segments.push({ kind: "math", text: blockBracket, display: true });
      index += 2 + blockBracket.length + 2;
      continue;
    }
    // 行内公式：\(...\) 与 $...$（$ 需要看起来像公式）
    const inlineParen = takeDelimited("\\(", "\\)");
    if (inlineParen !== null) {
      flushText();
      segments.push({ kind: "math", text: inlineParen, display: false });
      index += 2 + inlineParen.length + 2;
      continue;
    }
    const inlineDollar = takeDelimited("$", "$");
    if (inlineDollar !== null && looksLikeMath(inlineDollar)) {
      flushText();
      segments.push({ kind: "math", text: inlineDollar, display: false });
      index += 1 + inlineDollar.length + 1;
      continue;
    }

    buffer += source[index];
    index += 1;
  }
  flushText();
  return segments;
}

function renderMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: "htmlAndMathml",
    });
  } catch {
    return "";
  }
}

/**
 * 聊天气泡正文：把 `$...$` / `$$...$$` / `\(...\)` / `\[...\]` 渲染成公式，
 * 同时把 ```代码块``` 和 `行内代码` 排成等宽样式。其余文本原样输出。
 */
export function ChatText({ text }: { text: string }) {
  const segments = useMemo(() => parseSegments(text), [text]);

  return (
    <div className="chat-text">
      {segments.map((segment, index) => {
        if (segment.kind === "code") {
          return segment.block ? (
            <pre className="chat-text__code" key={index}>
              <code>{segment.text.replace(/\n$/, "")}</code>
            </pre>
          ) : (
            <code className="chat-text__inline-code" key={index}>
              {segment.text}
            </code>
          );
        }
        if (segment.kind === "math") {
          const html = renderMath(segment.text, segment.display);
          if (!html) {
            return (
              <code className="chat-text__inline-code" key={index}>
                {segment.text}
              </code>
            );
          }
          return (
            <span
              key={index}
              className={segment.display ? "chat-text__math chat-text__math--block" : "chat-text__math"}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </div>
  );
}
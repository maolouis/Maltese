// 小红书图文草稿（MVP2）：只准备文案，配图用平台「文生图」，最后一步人工发布。
//
// 边界（docs/video-plugin-xiaohongshu.md）：
// * 不下载/不转存他人原图（防盗链 + 版权）；
// * 不自动发布，不调发布接口；
// * 文案可一键复制到创作中心。

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

/** 小红书创作中心投稿页（默认停在「上传视频」，需手动切「上传图文」）。 */
export const XHS_PUBLISH_URL =
  "https://creator.xiaohongshu.com/publish/publish?source=official";

export type XhsDraftSource = {
  title: string;
  author: string | null;
  url: string;
  imageCount: number;
  noteType: string | null;
};

export type XhsDraft = {
  title: string;
  body: string;
  tags: string[];
  sources: XhsDraftSource[];
  generator: "model" | "template" | string;
  createdAt: number;
  dir: string;
};

export function XhsDraftPanel() {
  const [draft, setDraft] = useState<XhsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<XhsDraft>("xhs_generate_draft", {});
      setDraft(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "title" | "body" | "tags" | "all") => {
    if (!draft) return;
    const text =
      kind === "title"
        ? draft.title
        : kind === "body"
          ? draft.body
          : kind === "tags"
            ? draft.tags.join(" ")
            : `${draft.title}\n\n${draft.body}\n\n${draft.tags.join(" ")}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("复制失败：剪贴板不可用，可以手动选择文本");
    }
  };

  const openPublish = () => {
    void openUrl(XHS_PUBLISH_URL).catch(() => setError("打不开投稿页：请检查默认浏览器"));
  };

  const openDraftsDir = () => {
    void invoke("xhs_open_drafts_dir").catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <div className="xhs-draft">
      <div className="xhs-draft__head">
        <span className="assistant-panel__label">小红书图文草稿</span>
        <span className="video-automation__muted">只生成文案 · 配图用平台文生图 · 人工发布</span>
      </div>
      <div className="xhs-draft__actions">
        <button
          type="button"
          className="video-automation__secondary"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy ? "生成中…" : "生成图文草稿"}
        </button>
        <button type="button" className="video-automation__link" onClick={openPublish}>
          打开小红书投稿页
        </button>
        <button type="button" className="video-automation__link" onClick={openDraftsDir}>
          打开草稿文件夹
        </button>
      </div>
      {error && (
        <p className="video-history__error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <div className="xhs-draft__body">
          <p className="xhs-draft__label">
            标题（{draft.title.length} 字）
            <button type="button" className="video-automation__link" onClick={() => void copy("title")}>
              {copied === "title" ? "已复制" : "复制标题"}
            </button>
          </p>
          <p className="xhs-draft__title">{draft.title}</p>

          <p className="xhs-draft__label">
            正文（{draft.body.length} 字）
            <button type="button" className="video-automation__link" onClick={() => void copy("body")}>
              {copied === "body" ? "已复制" : "复制正文"}
            </button>
          </p>
          <pre className="xhs-draft__text">{draft.body}</pre>

          <p className="xhs-draft__label">
            标签（{draft.tags.length} 个）
            <button type="button" className="video-automation__link" onClick={() => void copy("tags")}>
              {copied === "tags" ? "已复制" : "复制标签"}
            </button>
          </p>
          <p className="xhs-draft__tags">{draft.tags.join(" ") || "（模型没给标签，可手动补）"}</p>

          <div className="xhs-draft__actions">
            <button type="button" className="video-automation__secondary" onClick={() => void copy("all")}>
              {copied === "all" ? "已复制全部" : "复制全部文案"}
            </button>
          </div>

          <p className="video-automation__muted">
            生成方式：{draft.generator === "model" ? "模型" : "模板"} · 来源 {draft.sources.length} 篇
            · 草稿目录：{draft.dir || "未写入"}
          </p>
          <p className="video-automation__muted">
            提醒：配图请用小红书创作中心的「文生图」生成，不要下载或转发原作者图片。
          </p>
        </div>
      )}
    </div>
  );
}
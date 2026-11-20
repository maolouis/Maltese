// 小红书图文草稿（模型自动编辑版）：可编辑预览 + 保存/复制/打开投稿页。
//
// 边界（docs/video-plugin-xiaohongshu.md）：
// * 只准备文案，不下载/不转存他人原图（配图用平台「文生图」）；
// * 不自动发布，最后一步人工完成；
// * 原创性由后端检查（≥15 字连续复制会重写/截断并标记 similar）。

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
  hook?: string;
  cta?: string;
  usedNotes?: string[];
  similar?: boolean;
  generator: "model" | "template" | string;
  createdAt: number;
  dir: string;
};

export function XhsDraftPanel() {
  const [draft, setDraft] = useState<XhsDraft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const applyDraft = (next: XhsDraft) => {
    setDraft(next);
    setTitle(next.title);
    setBody(next.body);
    setTagsText(next.tags.join(" "));
    setSavedAt(null);
  };

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<XhsDraft>("xhs_generate_draft", {});
      applyDraft(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const editedDraft = (): XhsDraft | null => {
    if (!draft) return null;
    const tags = tagsText
      .split(/[\s,，、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    return { ...draft, title, body, tags };
  };

  const save = async () => {
    const payload = editedDraft();
    if (!payload || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await invoke<XhsDraft>("xhs_save_draft", { draft: payload });
      applyDraft(saved);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const copyAll = async () => {
    if (!draft) return;
    const text = `${title}\n\n${body}\n\n${tagsText}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied("all");
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("复制失败：剪贴板不可用，可以手动选择文本");
    }
  };

  const openPublish = () => {
    void openUrl(XHS_PUBLISH_URL).catch(() => setError("打不开投稿页：请检查默认浏览器"));
  };

  return (
    <div className="xhs-draft">
      <div className="xhs-draft__head">
        <span className="assistant-panel__label">小红书图文草稿</span>
        <span className="video-automation__muted">
          模型自动编辑 · 可手动改 · 配图用平台文生图 · 人工发布
        </span>
      </div>
      <div className="xhs-draft__actions">
        <button
          type="button"
          className="video-automation__secondary"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy ? "生成中…" : draft ? "重新生成草稿" : "生成图文草稿"}
        </button>
        <button
          type="button"
          className="video-automation__link"
          onClick={() => void invoke("xhs_open_drafts_dir").catch(() => undefined)}
        >
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
          {draft.hook && <p className="xhs-draft__hook">开头：{draft.hook}</p>}

          <label className="xhs-draft__label" htmlFor="xhs-draft-title">
            标题（{title.length} / 20 字）
          </label>
          <input
            id="xhs-draft-title"
            className="xhs-draft__input"
            value={title}
            maxLength={40}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          <label className="xhs-draft__label" htmlFor="xhs-draft-body">
            正文（{body.length} / 1000 字）
          </label>
          <textarea
            id="xhs-draft-body"
            className="xhs-draft__textarea"
            value={body}
            rows={10}
            onChange={(event) => setBody(event.currentTarget.value)}
          />

          <label className="xhs-draft__label" htmlFor="xhs-draft-tags">
            标签（空格分隔，最多 8 个）
          </label>
          <input
            id="xhs-draft-tags"
            className="xhs-draft__input"
            value={tagsText}
            onChange={(event) => setTagsText(event.currentTarget.value)}
          />

          {draft.cta && <p className="xhs-draft__hook">结尾互动：{draft.cta}</p>}

          <div className="xhs-draft__actions">
            <button
              type="button"
              className="video-automation__secondary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存草稿"}
            </button>
            <button type="button" className="video-automation__secondary" onClick={() => void copyAll()}>
              {copied === "all" ? "已复制" : "复制全部"}
            </button>
            <button type="button" className="video-automation__link" onClick={openPublish}>
              打开投稿页
            </button>
          </div>

          <p className="video-automation__muted">
            生成方式：{draft.generator === "model" ? "模型" : "模板"}
            {draft.similar ? " · 曾命中相似度并已截断" : ""}
            {draft.usedNotes && draft.usedNotes.length > 0
              ? ` · 参考 ${draft.usedNotes.length} 篇笔记`
              : ""}
            {savedAt ? ` · 已保存 ${savedAt}` : ""}
          </p>
          <p className="video-automation__muted">
            来源：{draft.sources.map((source) => source.author || source.title).join("、") || "—"}
          </p>
          <p className="video-automation__muted">
            提醒：配图请用小红书创作中心的「文生图」生成，不要下载或转发原作者图片。
          </p>
        </div>
      )}
    </div>
  );
}
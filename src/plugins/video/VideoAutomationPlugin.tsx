// 「自动刷视频」插件的界面。
//
// 从 App.tsx 拆出来，插件窗口（`index.html?window=plugin`）和插件中心都复用同一个面板。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "../../App.css";
import { loadLocalChatConfig } from "../../localChat";

export type VideoAutomationSnapshot = {
  provider: "bilibili" | "douyin";
  running: boolean;
  intervalSeconds: number;
  maxMinutes: number;
  steps: number;
  startedAt: number | null;
  lastActionAt: number | null;
  currentUrl: string;
  waitingForBrowser: boolean;
  foregroundTitle: string;
  foregroundProcess: string;
  error: string | null;
};

const DEFAULT_VIDEO_AUTOMATION: VideoAutomationSnapshot = {
  provider: "bilibili",
  running: false,
  intervalSeconds: 45,
  maxMinutes: 30,
  steps: 0,
  startedAt: null,
  lastActionAt: null,
  currentUrl: "",
  waitingForBrowser: false,
  foregroundTitle: "",
  foregroundProcess: "",
  error: null,
};

export function VideoAutomationPanel({ onNotice }: { onNotice: (notice: string) => void }) {
  const [snapshot, setSnapshot] = useState<VideoAutomationSnapshot>(DEFAULT_VIDEO_AUTOMATION);
  const [provider, setProvider] = useState<"bilibili" | "douyin">("bilibili");
  const [intervalSeconds, setIntervalSeconds] = useState(45);
  const [maxMinutes, setMaxMinutes] = useState(30);
  // 评论区互动：生成一句评论 → 复制 / 直接敲进已聚焦的评论框。
  const [comment, setComment] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [autoComment, setAutoComment] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-video-auto-comment") === "on";
    } catch {
      return false;
    }
  });
  // 自动发送：剪贴板里的评论直接用 Ctrl+V + Enter 发出去。
  // 需要先把光标放进评论框（点一次），之后每轮都能自动发。
  const [autoSendComment, setAutoSendComment] = useState(() => {
    try {
      return window.localStorage.getItem("maltese-video-auto-send-comment") === "on";
    } catch {
      return false;
    }
  });

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<VideoAutomationSnapshot>("get_video_automation_state");
      setSnapshot(next);
      setProvider(next.provider);
      setIntervalSeconds(next.intervalSeconds);
      setMaxMinutes(next.maxMinutes);
    } catch {
      // Browser preview can run without the native API.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveConfig = useCallback(async () => {
    await invoke("set_video_automation_config", {
      config: {
        intervalSeconds: Math.max(15, Math.round(intervalSeconds)),
        maxMinutes: Math.max(1, Math.round(maxMinutes)),
      },
    });
  }, [intervalSeconds, maxMinutes]);

  const start = async () => {
    try {
      await saveConfig();
      await invoke("start_video_automation", { provider });
      await refresh();
      onNotice((provider === "bilibili" ? "B站" : "抖音") + " 自动刷视频已开始，请先在浏览器完成登录");
    } catch (error) {
      onNotice("自动刷视频启动失败：" + String(error));
    }
  };

  const stop = async () => {
    try {
      await invoke("stop_video_automation");
      await refresh();
      onNotice("自动刷视频已暂停");
    } catch (error) {
      onNotice("停止自动刷视频失败：" + String(error));
    }
  };

  const generateComment = useCallback(async () => {
    setCommentBusy(true);
    const title = snapshot.foregroundTitle || "";
    const fallback = [
      "这个视频讲得挺清楚的，学到了。",
      "刚好在找这个内容，谢谢分享。",
      "看到这里忍不住点赞，up 主加油。",
      "节奏很舒服，看着不累。",
    ];
    try {
      const config = loadLocalChatConfig();
      const prompt = `你是正在看视频的观众，视频标题是「${title || "未知视频"}」。请写一条不超过 20 个字的中文弹幕风格评论，自然、不夸张、不带话题标签。`;
      let text = "";
      try {
        if (config.backend === "local" && config.model) {
          text = await invoke<string>("local_chat", {
            baseUrl: config.baseUrl,
            model: config.model,
            apiKey: config.apiKey.trim() || null,
            message: prompt,
            history: [],
            character: "xiaobai",
            images: null,
          });
        } else {
          const reply = await invoke<{ text: string }>("dsh_chat", {
            message: prompt,
            sessionId: null,
            character: "xiaobai",
          });
          text = reply.text;
        }
      } catch {
        text = "";
      }
      const line = (text || "").trim().replace(/^["「『]|["」』]$/g, "");
      setComment(line || fallback[Math.floor(Math.random() * fallback.length)]);
    } finally {
      setCommentBusy(false);
    }
  }, [snapshot.foregroundTitle]);

  const copyComment = useCallback(async (text: string) => {
    try {
      await invoke("set_clipboard_text", { text });
      return true;
    } catch {
      return false;
    }
  }, []);

  // 自动评论：每次翻页后生成一句并放进剪贴板，用户点开评论框直接 Ctrl+V。
  const lastStepsRef = useRef(0);
  useEffect(() => {
    if (!autoComment) {
      lastStepsRef.current = snapshot.steps;
      return;
    }
    if (snapshot.steps > lastStepsRef.current) {
      lastStepsRef.current = snapshot.steps;
      void (async () => {
        await generateComment();
      })();
    }
  }, [autoComment, generateComment, snapshot.steps]);

  useEffect(() => {
    if (!autoComment || !comment) return;
    void (async () => {
      const ok = await copyComment(comment);
      if (!ok || !autoSendComment) return;
      try {
        await invoke("press_shortcut", { shortcut: "ctrl+v" });
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        await invoke("press_shortcut", { shortcut: "enter" });
      } catch {
        // 光标不在评论框时按不出去，忽略
      }
    })();
  }, [autoComment, autoSendComment, comment, copyComment]);
  return (
    <section className="video-automation" aria-label="自动刷视频">
      <div className="video-automation__head">
        <div>
          <span className="assistant-panel__label">自动翻页</span>
          <strong>{snapshot.running ? snapshot.waitingForBrowser ? "等待视频页回到前台" : "正在观看" : "已暂停"}</strong>
        </div>
        <span className="video-automation__steps">已翻页 {snapshot.steps} 次</span>
      </div>
      <div className="video-automation__controls">
        <select value={provider} onChange={(event) => setProvider(event.target.value as "bilibili" | "douyin")}>
          <option value="bilibili">B站推荐流</option>
          <option value="douyin">抖音推荐流</option>
        </select>
        <label>间隔 <input type="number" min={15} max={600} value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value) || 45)} /> 秒</label>
        <label>上限 <input type="number" min={1} max={240} value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.target.value) || 30)} /> 分钟</label>
        {snapshot.running ? (
          <button type="button" onClick={() => void stop()}>暂停</button>
        ) : (
          <button type="button" onClick={() => void start()}>开始</button>
        )}
      </div>
      <p className="video-automation__hint">
        打开有窗口浏览器并登录，保持视频页在前台；首次翻页约 6 秒后执行，之后按间隔翻页。
        切到其他窗口时会自动暂停，不抢焦点、不乱按键。
      </p>
      <div className="video-automation__comment">
        <div className="video-automation__comment-head">
          <span className="assistant-panel__label">评论区</span>
          <label className="video-automation__comment-toggle">
            <input
              type="checkbox"
              checked={autoComment}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoComment(next);
                try {
                  window.localStorage.setItem("maltese-video-auto-comment", next ? "on" : "off");
                } catch {
                  // 忽略
                }
              }}
            />
            <span>每次翻页后自动准备一句评论</span>
          </label>
          <label className="video-automation__comment-toggle">
            <input
              type="checkbox"
              checked={autoSendComment}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoSendComment(next);
                try {
                  window.localStorage.setItem("maltese-video-auto-send-comment", next ? "on" : "off");
                } catch {
                  // 忽略
                }
              }}
            />
            <span>自动发送（先把光标点进评论框）</span>
          </label>
        </div>
        <textarea
          value={comment}
          rows={2}
          placeholder="小狗会按当前视频写一句，也可以自己改"
          onChange={(event) => setComment(event.currentTarget.value)}
        />
        <div className="video-automation__comment-actions">
          <button type="button" disabled={commentBusy} onClick={() => void generateComment()}>
            {commentBusy ? "生成中…" : "生成评论"}
          </button>
          <button
            type="button"
            disabled={!comment.trim()}
            onClick={() =>
              void copyComment(comment).then((ok) =>
                onNotice(ok ? "评论已复制，点开评论框 Ctrl+V 即可" : "复制失败"),
              )
            }
          >
            复制
          </button>
          <button
            type="button"
            disabled={!comment.trim()}
            onClick={() =>
              void (async () => {
                const ok = await copyComment(comment);
                try {
                  await invoke("type_text", { text: comment });
                  onNotice("已把评论敲进当前输入框，回车发送即可");
                } catch (error) {
                  onNotice(`输入失败：${String(error)}${ok ? "（评论已复制）" : ""}`);
                }
              })()
            }
          >
            输入到评论框
          </button>
        </div>
        <p className="video-automation__hint">
          先用鼠标点一下网页里的评论输入框，再点「输入到评论框」。勾选「自动发送」后，每轮会自动粘贴并回车；
          光标不在评论框时不会乱发。
        </p>
        <div className="video-automation__publish">
          <span className="assistant-panel__label">投稿 / 开播（半自动）</span>
          <div className="video-automation__comment-actions">
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  const title = snapshot.foregroundTitle || "";
                  const desc = comment || "（在这里补充简介）";
                  await invoke("set_clipboard_text", {
                    text: `${title}\n${desc}\n\n（由 Maltese 准备的标题与简介，粘贴到投稿页即可）`,
                  }).catch(() => undefined);
                  await invoke("open_local_path", {
                    path:
                      provider === "bilibili"
                        ? "https://member.bilibili.com/platform/upload/video/frame"
                        : "https://creator.douyin.com/creator-micro/content/upload",
                  }).catch(() => undefined);
                  onNotice("已打开投稿页，标题和简介已复制，粘贴即可；发布需要你本人确认。");
                })()
              }
            >
              准备投稿
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  await invoke("open_local_path", {
                    path:
                      provider === "bilibili"
                        ? "https://link.bilibili.com/p/center/index#/user-center/my-info/live-data"
                        : "https://creator.douyin.com/creator-micro/content/manage?enter_from=live",
                  }).catch(() => undefined);
                  onNotice("已打开直播中心；开播的实名认证、推流信息需要你在网页里确认。");
                })()
              }
            >
              打开直播中心
            </button>
          </div>
          <p className="video-automation__hint">
            上传视频与开播涉及实名认证、版权与平台风控，Maltese 只帮你打开官方页面并准备好文案，
            不会代替你点发布或推流。
          </p>
        </div>
      </div>
      {snapshot.running && snapshot.waitingForBrowser && snapshot.foregroundTitle && (
        <p className="video-automation__hint video-automation__hint--warn">
          当前前台：{snapshot.foregroundTitle}
          {snapshot.foregroundProcess ? `（${snapshot.foregroundProcess}）` : ""}
          ，请点一下浏览器里的 B 站/抖音页面。
        </p>
      )}
    </section>
  );
}

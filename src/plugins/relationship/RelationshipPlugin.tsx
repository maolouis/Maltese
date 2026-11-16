// 「关系」插件：两个人用配对码连起来，选好关系之后在这里互聊。
//
// 通信只经过公网中继（默认 ntfy.sh），消息在本地加密后再发；
// 配对码 = 频道名 + 密钥，所以两个人必须用同一个码。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Link2, RefreshCw, Send, Unlink } from "lucide-react";
import { decryptMessage, encryptMessage, generatePairCode, isPresenceFresh, topicForCode } from "./pairing";
import "./RelationshipPlugin.css";

type Relation = "couple" | "friend" | "brother";

const RELATIONS: Array<{ id: Relation; label: string; hint: string }> = [
  { id: "couple", label: "情侣", hint: "两个人的日常、想念和晚安" },
  { id: "friend", label: "朋友", hint: "随时分享有意思的事" },
  { id: "brother", label: "兄弟", hint: "一句话就能懂的默契" },
];

const RELATION_LABELS: Record<Relation, string> = {
  couple: "情侣",
  friend: "朋友",
  brother: "兄弟",
};

/** 心情：用户自己选，随 presence 消息一起同步给对方。 */
type Emotion = "happy" | "calm" | "tired" | "upset" | "lonely";

const EMOTIONS: Array<{ id: Emotion; label: string; emoji: string }> = [
  { id: "happy", label: "开心", emoji: "😄" },
  { id: "calm", label: "平静", emoji: "🙂" },
  { id: "tired", label: "有点累", emoji: "😮‍💨" },
  { id: "upset", label: "有点烦", emoji: "😤" },
  { id: "lonely", label: "想人陪", emoji: "🥺" },
];

const EMOTION_LABELS: Record<Emotion, string> = {
  happy: "开心",
  calm: "平静",
  tired: "有点累",
  upset: "有点烦",
  lonely: "想人陪",
};

const EMOTION_EMOJI: Record<Emotion, string> = {
  happy: "😄",
  calm: "🙂",
  tired: "😮‍💨",
  upset: "😤",
  lonely: "🥺",
};

function isEmotion(value: unknown): value is Emotion {
  return value === "happy" || value === "calm" || value === "tired" || value === "upset" || value === "lonely";
}

/** 本地工作状态：读前台窗口，失败就回退成「在忙」。 */
async function readMyWork(): Promise<string> {
  try {
    const info = await invoke<{ kind: string; title: string }>("get_active_activity");
    const labels: Record<string, string> = {
      code: "在写代码",
      video: "在看视频",
      browser: "在逛网页",
      meeting: "在开会",
      chat: "在聊天",
      game: "在打游戏",
      music: "在听歌",
      office: "在写文档",
      design: "在画图",
      idle: "在发呆",
    };
    const base = labels[info.kind] ?? "在忙";
    const title = (info.title ?? "").trim().slice(0, 24);
    return title ? `${base}（${title}）` : base;
  } catch {
    return "在忙";
  }
}

const PAIR_KEY = "maltese-relationship:pair";
const LOG_KEY = "maltese-relationship:log";
const SENT_KEY = "maltese-relationship:sent";
const RELAY_KEY = "maltese-relationship:relay";
const POLL_MS = 3000;
const MAX_LOG = 200;

type PairState = {
  code: string;
  myName: string;
  myRelation: Relation | null;
  peerName: string;
  peerRelation: Relation | null;
  since: string;
  lastSeenAt: number;
  /** 我此刻的分享状态 */
  myEmotion: Emotion | null;
  myWork: string;
  /** 对方最近一次上报的状态 */
  peerEmotion: Emotion | null;
  peerWork: string;
  peerStatusAt: number;
};

type LogItem = {
  id: string;
  at: number;
  mine: boolean;
  text: string;
};

type RelayMessage = { id: string; time: number; body: string };

const EMPTY_PAIR: PairState = {
  code: "",
  myName: "",
  myRelation: null,
  peerName: "",
  peerRelation: null,
  since: "",
  lastSeenAt: 0,
  myEmotion: null,
  myWork: "",
  peerEmotion: null,
  peerWork: "",
  peerStatusAt: 0,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下就只保留当前会话。
  }
}

function relayBase(): string {
  try {
    return window.localStorage.getItem(RELAY_KEY)?.trim() || "https://ntfy.sh";
  } catch {
    return "https://ntfy.sh";
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRelation(value: unknown): value is Relation {
  return value === "couple" || value === "friend" || value === "brother";
}

export function RelationshipPlugin() {
  const [pair, setPair] = useState<PairState>(() => ({
    ...EMPTY_PAIR,
    ...readJson<Partial<PairState>>(PAIR_KEY, {}),
  }));
  const [log, setLog] = useState<LogItem[]>(() => readJson<LogItem[]>(LOG_KEY, []));
  const [draft, setDraft] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const sentRef = useRef<Set<string>>(new Set(readJson<string[]>(SENT_KEY, [])));
  const logRef = useRef(log);
  logRef.current = log;
  // 收到对方 hello 后只回一次，避免双方互相回包形成 ping-pong。
  const helloRepliedRef = useRef(false);

  const savePair = useCallback((next: PairState) => {
    setPair(next);
    writeJson(PAIR_KEY, next);
  }, []);

  const appendLog = useCallback((item: LogItem) => {
    setLog((current) => {
      const next = [...current, item].slice(-MAX_LOG);
      writeJson(LOG_KEY, next);
      return next;
    });
  }, []);

  const rememberSent = useCallback((id: string) => {
    sentRef.current.add(id);
    writeJson(SENT_KEY, [...sentRef.current].slice(-200));
  }, []);

  /** 发一条加密消息到中继。code 显式传入，避免闭包抓到刚保存前的空配对码。 */
  const send = useCallback(
    async (code: string, payload: Record<string, unknown>) => {
      const activeCode = code.trim().toUpperCase();
      if (!activeCode || !isTauri()) return false;
      try {
        const sid = randomId();
        const body = await encryptMessage(activeCode, { ...payload, sid });
        await invoke("relay_publish", {
          base: relayBase(),
          topic: await topicForCode(activeCode),
          body,
        });
        rememberSent(sid);
        return true;
      } catch (error) {
        setStatus(`发送失败：${String(error)}`);
        return false;
      }
    },
    [rememberSent],
  );

  /** 拉一次新消息并处理。 */
  const poll = useCallback(async () => {
    const code = pair.code;
    if (!code || !isTauri()) return;
    let messages: RelayMessage[] = [];
    try {
      messages = await invoke<RelayMessage[]>("relay_fetch", {
        base: relayBase(),
        topic: await topicForCode(code),
        since: pair.since || "all",
      });
    } catch (error) {
      setStatus(`连接中断：${String(error)}`);
      return;
    }
    if (messages.length === 0) return;

    let lastTime = Number(pair.since) || 0;
    let peerName = pair.peerName;
    let peerRelation = pair.peerRelation;
    let peerWork = pair.peerWork;
    let peerEmotion = pair.peerEmotion;
    let peerStatusAt = pair.peerStatusAt;
    let touched = false;

    for (const message of messages) {
      lastTime = Math.max(lastTime, message.time);
      const payload = (await decryptMessage(code, message.body)) as
        | {
            t?: string;
            sid?: string;
            name?: string;
            v?: string;
            text?: string;
            at?: number;
            work?: string;
            emotion?: string;
          }
        | null;
      if (!payload) continue;
      if (payload.sid && sentRef.current.has(payload.sid)) continue;

      if (payload.t === "hello" && payload.name) {
        peerName = payload.name;
        touched = true;
        setStatus(`${payload.name} 已连接`);
        // 对方首次报上线时回一次 hello，发起方的“已连接”状态才能点亮。
        if (!helloRepliedRef.current) {
          helloRepliedRef.current = true;
          void send(pair.code, { t: "hello", name: pair.myName || "我", at: Date.now() });
        }
      } else if (payload.t === "relation" && isRelation(payload.v)) {
        peerRelation = payload.v;
        touched = true;
      } else if (payload.t === "chat" && payload.text) {
        const text = String(payload.text).slice(0, 500);
        if (!logRef.current.some((item) => item.id === message.id)) {
          appendLog({ id: message.id, at: message.time * 1000 || Date.now(), mine: false, text });
          touched = true;
        }
      } else if (payload.t === "presence") {
        // 对方上报「正在做什么 / 心情怎么样」
        if (typeof payload.work === "string") peerWork = payload.work.slice(0, 60);
        if (isEmotion(payload.emotion)) peerEmotion = payload.emotion;
        peerStatusAt = Date.now();
        touched = true;
      } else if (payload.t === "bye") {
        peerName = "";
        peerRelation = null;
        peerWork = "";
        peerEmotion = null;
        peerStatusAt = 0;
        setStatus("对方已断开");
        touched = true;
      }
    }

    if (touched || lastTime > (Number(pair.since) || 0)) {
      savePair({
        ...pair,
        peerName,
        peerRelation,
        peerWork,
        peerEmotion,
        peerStatusAt,
        since: String(lastTime),
        lastSeenAt: touched ? Date.now() : pair.lastSeenAt,
      });
    }
  }, [appendLog, pair, savePair, send]);

  /** 把自己的工作状态 + 心情发给对方。 */
  const shareStatus = useCallback(
    async (emotion: Emotion | null) => {
      if (!pair.code || !isTauri()) return;
      const work = await readMyWork();
      savePair({ ...pair, myEmotion: emotion, myWork: work });
      await send(pair.code, {
        t: "presence",
        work,
        emotion: emotion ?? undefined,
        name: pair.myName || "我",
        at: Date.now(),
      });
    },
    [pair, savePair, send],
  );

  /** 配对后每 30 秒上报一次，对方就能看到「我刚才在做什么」。 */
  useEffect(() => {
    if (!pair.code || !isTauri()) return;
    const push = () => {
      void shareStatus(pair.myEmotion ?? null);
    };
    const timer = window.setInterval(push, 30_000);
    return () => window.clearInterval(timer);
  }, [pair.code, pair.myEmotion, shareStatus]);

  useEffect(() => {
    if (!pair.code || !isTauri()) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pair.code, poll]);

  // 输名字之前先给一个默认称呼，省掉一个必填项。
  const myName = pair.myName || name.trim() || "我";

  const createCode = () => {
    const code = generatePairCode();
    helloRepliedRef.current = false;
    savePair({ ...EMPTY_PAIR, code, myName, since: "" });
    setStatus("配对码已生成，把它发给对方，等对方输入后就能连上");
    void send(code, { t: "hello", name: myName, at: Date.now() });
  };

  const join = async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      setStatus("配对码至少 4 位");
      return;
    }
    setBusy(true);
    helloRepliedRef.current = false;
    savePair({ ...EMPTY_PAIR, code, myName, since: "" });
    setJoinCode("");
    await send(code, { t: "hello", name: myName, at: Date.now() });
    setStatus("已加入这个配对码，正在等对方回应");
    setBusy(false);
  };

  const chooseRelation = async (relation: Relation) => {
    savePair({ ...pair, myRelation: relation, myName });
    await send(pair.code, { t: "relation", v: relation, name: myName, at: Date.now() });
    setStatus(`已选定：${RELATION_LABELS[relation]}`);
  };

  const chooseEmotion = async (emotion: Emotion) => {
    setStatus(`心情已更新：${EMOTION_LABELS[emotion]}`);
    await shareStatus(emotion);
  };

  const copyCode = async () => {
    try {
      await invoke("set_clipboard_text", { text: pair.code });
      setStatus("配对码已复制");
    } catch {
      setStatus("复制失败");
    }
  };

  const disconnect = async () => {
    await send(pair.code, { t: "bye", at: Date.now() });
    helloRepliedRef.current = false;
    savePair({
      ...pair,
      peerName: "",
      peerRelation: null,
      peerWork: "",
      peerEmotion: null,
      peerStatusAt: 0,
      since: "",
    });
    setLog([]);
    writeJson(LOG_KEY, []);
    setStatus("已断开，配对码仍然保留，可以再连回来");
  };

  const sendChat = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const ok = await send(pair.code, { t: "chat", text, name: myName, at: Date.now() });
    if (ok) appendLog({ id: randomId(), at: Date.now(), mine: true, text });
    else setDraft(text);
  };

  const peerFresh = pair.lastSeenAt === 0 || isPresenceFresh(pair.lastSeenAt);
  const peerOnline = (Boolean(pair.peerName) || Boolean(pair.peerRelation)) && peerFresh;
  const peerPresenceFresh = isPresenceFresh(pair.peerStatusAt);
  const relationConfirmed =
    pair.myRelation && pair.peerRelation && pair.myRelation === pair.peerRelation;

  return (
    <section className="relationship" aria-label="关系">
      {!pair.code ? (
        <div className="relationship__intro">
          <div className="relationship__card">
            <h2 className="relationship__title">两个人，连起来</h2>
            <p className="relationship__lead">
              一方生成配对码，另一方输入同一个码，就能在这里互聊。消息在你们两台机器上加密，中继只转发密文。
            </p>
            <label className="relationship__field">
              <span>你的称呼</span>
              <input
                value={name}
                maxLength={12}
                placeholder="对方看到的名字"
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <button type="button" className="relationship__primary" onClick={createCode}>
              <Link2 size={16} strokeWidth={2} aria-hidden="true" />
              生成配对码
            </button>
          </div>
          <div className="relationship__card relationship__card--join">
            <h3 className="relationship__subtitle">已经有对方的配对码</h3>
            <div className="relationship__join">
              <input
                value={joinCode}
                maxLength={8}
                placeholder="输入对方的配对码"
                spellCheck={false}
                onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void join();
                }}
              />
              <button type="button" disabled={busy || joinCode.trim().length < 4} onClick={() => void join()}>
                加入
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <header className="relationship__head">
            <div className="relationship__code-block">
              <span className="relationship__label">配对码</span>
              <strong className="relationship__code">{pair.code}</strong>
            </div>
            <div className="relationship__head-actions">
              <button type="button" onClick={() => void copyCode()}>复制</button>
              <button type="button" onClick={createCode}>换一个</button>
              <button
                type="button"
                onClick={() => {
                  savePair({ ...EMPTY_PAIR, myName: pair.myName });
                  setStatus("已退出这个配对码");
                }}
              >
                退出
              </button>
            </div>
          </header>

          <div className={`relationship__status${peerOnline ? " relationship__status--on" : ""}`}>
            {peerOnline ? `${pair.peerName || "对方"} 已连接` : "等待对方输入这个配对码…"}
          </div>

          <div className="relationship__relations">
            {RELATIONS.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`relationship__relation${pair.myRelation === item.id ? " is-active" : ""}`}
                onClick={() => void chooseRelation(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
          <p className="relationship__confirm">
            {relationConfirmed
              ? `你们的关系：${RELATION_LABELS[pair.myRelation as Relation]}`
              : pair.peerRelation
                ? `对方选了「${RELATION_LABELS[pair.peerRelation]}」，你选了「${
                    pair.myRelation ? RELATION_LABELS[pair.myRelation] : "还没选"
                  }」`
                : pair.myRelation
                  ? "等对方也选一个，两边一致就确认关系"
                  : "先选一个关系，对方也选同一个就确认"}
          </p>

          <div className="relationship__presence">
            <div className="relationship__presence-card">
              <span className="relationship__presence-label">
                {pair.peerName || "对方"} 现在
              </span>
              {peerOnline ? (
                <>
                  <strong className="relationship__presence-work">
                    {peerPresenceFresh ? pair.peerWork || "还没上报状态" : "状态暂未更新"}
                  </strong>
                  <span className="relationship__presence-mood">
                    {peerPresenceFresh && pair.peerEmotion ? (
                      <>
                        {EMOTION_EMOJI[pair.peerEmotion]} 心情：{EMOTION_LABELS[pair.peerEmotion]}
                      </>
                    ) : (
                      "心情：还没说"
                    )}
                  </span>
                  {peerPresenceFresh && pair.peerStatusAt > 0 && (
                    <small className="relationship__presence-time">
                      更新于 {Math.max(0, Math.round((Date.now() - pair.peerStatusAt) / 60000))} 分钟前
                    </small>
                  )}
                </>
              ) : (
                <span className="relationship__presence-mood">对方还没连上</span>
              )}
            </div>
            <div className="relationship__presence-mine">
              <span className="relationship__presence-label">我现在的心情</span>
              <div className="relationship__emotions">
                {EMOTIONS.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`relationship__emotion${pair.myEmotion === item.id ? " is-active" : ""}`}
                    title={`告诉对方：${item.label}`}
                    onClick={() => void chooseEmotion(item.id)}
                  >
                    <span aria-hidden="true">{item.emoji}</span>
                    {item.label}
                  </button>
                ))}
              </div>
              <small className="relationship__presence-time">
                你的工作状态（{pair.myWork || "还没上报"}）会随心情一起同步，每 30 秒自动刷新一次。
              </small>
            </div>
          </div>

          <div className="relationship__chat">
            <div className="relationship__log">
              {log.length === 0 && <p className="relationship__empty">还没有消息，先说句话吧</p>}
              {log.map((item) => (
                <div key={item.id} className={`relationship__bubble${item.mine ? " is-mine" : ""}`}>
                  {item.text}
                </div>
              ))}
            </div>
            <div className="relationship__compose">
              <input
                value={draft}
                maxLength={500}
                placeholder="想说的话"
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendChat();
                }}
              />
              <button type="button" className="relationship__send" disabled={!draft.trim()} onClick={() => void sendChat()}>
                <Send size={16} strokeWidth={2} aria-hidden="true" />
                发送
              </button>
            </div>
          </div>

          <div className="relationship__foot">
            <button type="button" className="relationship__danger" onClick={() => void disconnect()}>
              <Unlink size={15} strokeWidth={2} aria-hidden="true" />
              断开
            </button>
            <button type="button" onClick={() => void poll()}>
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
              刷新
            </button>
          </div>
        </>
      )}
      {status && <p className="relationship__notice" role="status">{status}</p>}
    </section>
  );
}

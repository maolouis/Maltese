// 「关系」插件：两个人用配对码连起来，选好关系之后在这里互聊。
//
// 通信只经过公网中继（默认 ntfy.sh），消息在本地加密后再发；
// 配对码 = 频道名 + 密钥，所以两个人必须用同一个码。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Link2, RefreshCw, Send, Unlink } from "lucide-react";
import { decryptMessage, encryptMessage, generatePairCode, topicForCode } from "./pairing";
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

  /** 发一条加密消息到中继。 */
  const send = useCallback(
    async (payload: Record<string, unknown>) => {
      const code = pair.code;
      if (!code || !isTauri()) return false;
      try {
        const sid = randomId();
        const body = await encryptMessage(code, { ...payload, sid });
        await invoke("relay_publish", {
          base: relayBase(),
          topic: await topicForCode(code),
          body,
        });
        rememberSent(sid);
        return true;
      } catch (error) {
        setStatus(`发送失败：${String(error)}`);
        return false;
      }
    },
    [pair.code, rememberSent],
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
    let touched = false;

    for (const message of messages) {
      lastTime = Math.max(lastTime, message.time);
      const payload = (await decryptMessage(code, message.body)) as
        | { t?: string; sid?: string; name?: string; v?: string; text?: string; at?: number }
        | null;
      if (!payload) continue;
      if (payload.sid && sentRef.current.has(payload.sid)) continue;

      if (payload.t === "hello" && payload.name) {
        peerName = payload.name;
        touched = true;
        setStatus(`${payload.name} 已连接`);
      } else if (payload.t === "relation" && isRelation(payload.v)) {
        peerRelation = payload.v;
        touched = true;
      } else if (payload.t === "chat" && payload.text) {
        const text = String(payload.text).slice(0, 500);
        if (!logRef.current.some((item) => item.id === message.id)) {
          appendLog({ id: message.id, at: message.time * 1000 || Date.now(), mine: false, text });
          touched = true;
        }
      } else if (payload.t === "bye") {
        peerName = "";
        peerRelation = null;
        setStatus("对方已断开");
        touched = true;
      }
    }

    if (touched || lastTime > (Number(pair.since) || 0)) {
      savePair({
        ...pair,
        peerName,
        peerRelation,
        since: String(lastTime),
        lastSeenAt: touched ? Date.now() : pair.lastSeenAt,
      });
    }
  }, [appendLog, pair, savePair]);

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
    savePair({ ...EMPTY_PAIR, code, myName, since: "" });
    setStatus("配对码已生成，把它发给对方，等对方输入后就能连上");
  };

  const join = async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      setStatus("配对码至少 4 位");
      return;
    }
    setBusy(true);
    savePair({ ...EMPTY_PAIR, code, myName, since: "" });
    setJoinCode("");
    await send({ t: "hello", name: myName, at: Date.now() });
    setStatus("已加入这个配对码，正在等对方回应");
    setBusy(false);
  };

  const chooseRelation = async (relation: Relation) => {
    savePair({ ...pair, myRelation: relation, myName });
    await send({ t: "relation", v: relation, name: myName, at: Date.now() });
    setStatus(`已选定：${RELATION_LABELS[relation]}`);
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
    await send({ t: "bye", at: Date.now() });
    savePair({ ...pair, peerName: "", peerRelation: null, since: "" });
    setLog([]);
    writeJson(LOG_KEY, []);
    setStatus("已断开，配对码仍然保留，可以再连回来");
  };

  const sendChat = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const ok = await send({ t: "chat", text, name: myName, at: Date.now() });
    if (ok) appendLog({ id: randomId(), at: Date.now(), mine: true, text });
    else setDraft(text);
  };

  const peerOnline = Boolean(pair.peerName) || Boolean(pair.peerRelation);
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

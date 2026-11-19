#!/usr/bin/env node
// 刷视频稳定性自测探针：启动一轮会话 → 每 15s 打印进度 → 到点停止并汇总。
//
// 用法（应用需先运行，脚本通过本机 DSH API 驱动）：
//   node scripts/video-stability-probe.mjs
//   node scripts/video-stability-probe.mjs --minutes=6 --every=15 --page-interval=15
//   node scripts/video-stability-probe.mjs --report=.tmp-video/run1.json
//
// 退出码：0 = 采到 ≥3 条不同视频；1 = 不足；2 = 应用没起 / API 连不上；3 = 跑到一半应用被重启（本轮作废）。
// 只读应用数据目录、只调用本机 API，不改任何业务数据。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_DATA = path.join(process.env.APPDATA || os.homedir(), "com.maolouis.maltese");
const VIDEO_DATA = path.join(APP_DATA, "video");
const LOG_DIR = path.join(VIDEO_DATA, "logs");
const TOKEN_FILE = path.join(APP_DATA, "dsh-api-token.txt");
const PORT_FILE = path.join(APP_DATA, "dsh-api-port.txt");
const ACCOUNTS_FILE = path.join(VIDEO_DATA, "accounts.json");

const KEY_CODES = new Set([
  "SESSION_STARTED",
  "SESSION_STOPPED",
  "SESSION_SUMMARY",
  "CANDIDATES",
  "CANDIDATES_EMPTY",
  "NAV_ATTEMPT",
  "NAV_VERIFIED",
  "NAV_FAILED",
  "NAV_TIMEOUT",
  "TARGET_HEALTH",
  "ITEM_COLLECTED",
  "ITEM_DISCARDED",
  "ROUND",
  "URL_FAILED",
  "URL_BLACKLIST",
  "BROWSER_RESTART",
  "BROWSER_ENFORCED_SINGLE",
  "CDP_RECOVER",
  "CDP_UNAVAILABLE",
  "STALL_WATCH",
  "EXTRACT_FAILED",
  "LOGIN_REQUIRED",
]);

function parseArgs(argv) {
  const options = {
    minutes: 6,
    every: 15,
    pageInterval: 15,
    maxItems: 200,
    account: true,
    report: "",
  };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, "").split("=");
    if (key === "minutes") options.minutes = Number(value || 6);
    else if (key === "every") options.every = Math.max(3, Number(value || 15));
    else if (key === "page-interval") options.pageInterval = Math.max(15, Number(value || 15));
    else if (key === "max-items") options.maxItems = Number(value || 200);
    else if (key === "no-account") options.account = false;
    else if (key === "report") options.report = value || "";
    else if (key === "help" || key === "-h") {
      console.log(
        "用法: node scripts/video-stability-probe.mjs [--minutes=6] [--every=15] [--page-interval=15] [--no-account] [--report=path]"
      );
      process.exit(0);
    }
  }
  return options;
}

function readPort() {
  try {
    const value = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // 端口文件不存在时回退到默认端口。
  }
  return 3218;
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function readActiveAccount() {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    const id = data.activeAccountId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function newestLogFile() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((name) => /^video-\d{8}\.jsonl$/.test(name))
      .map((name) => path.join(LOG_DIR, name))
      .map((file) => ({ file, at: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return files.length ? files[0].file : null;
  } catch {
    return null;
  }
}

function stamp(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/// 增量读日志：只解析探针启动之后写入的行，避免混进历史会话。
function createLogTail() {
  let currentFile = null;
  let offset = 0;
  let partial = "";
  const events = [];
  const seekToEnd = () => {
    const file = newestLogFile();
    currentFile = file;
    if (!file) return;
    try {
      offset = fs.statSync(file).size;
    } catch {
      offset = 0;
    }
    partial = "";
  };
  return {
    events,
    seekToEnd,
    read() {
      const file = newestLogFile();
      if (!file) return [];
      if (file !== currentFile) {
        currentFile = file;
        offset = 0;
        partial = "";
        console.log(`[log] 跟踪 ${file}`);
      }
      let text;
      try {
        const stat = fs.statSync(file);
        if (stat.size <= offset) return [];
        const fd = fs.openSync(file, "r");
        try {
          const length = stat.size - offset;
          const chunk = Buffer.alloc(length);
          fs.readSync(fd, chunk, 0, length, offset);
          offset = stat.size;
          text = chunk.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return [];
      }
      const lines = (partial + text).split("\n");
      partial = lines.pop() || "";
      const parsed = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        events.push(entry);
        parsed.push(entry);
      }
      return parsed;
    },
  };
}

async function api(port, token, method, route, body, timeoutMs = 10000) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-maltese-token"] = token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function printEvent(entry) {
  console.log(`[log ${entry.code}] ${entry.message}`);
}

function summarize(events, status) {
  const codes = {};
  const collected = new Set();
  const candidates = [];
  const rounds = [];
  const blacklist = [];
  const summaries = [];
  const failures = [];
  for (const entry of events) {
    codes[entry.code] = (codes[entry.code] || 0) + 1;
    if (entry.code === "ITEM_COLLECTED") {
      const match = /url=(\S+)/.exec(entry.message || "");
      if (match) collected.add(match[1].replace(/[?#].*$/, ""));
    } else if (entry.code === "CANDIDATES") candidates.push(entry.message);
    else if (entry.code === "ROUND") rounds.push(entry.message);
    else if (entry.code === "URL_BLACKLIST") blacklist.push(entry.message);
    else if (entry.code === "SESSION_SUMMARY") summaries.push(entry.message);
    else if (entry.code === "URL_FAILED" || entry.code === "NAV_TIMEOUT") failures.push(entry.message);
  }
  return {
    codeCounts: codes,
    distinctVideos: [...collected],
    candidates: candidates.slice(-6),
    rounds: rounds.slice(-14),
    blacklist,
    summaries: summaries.slice(-2),
    failures: failures.slice(-10),
    finalStatus: status,
  };
}

function printReport(report, finalStatus) {
  console.log("\n===== 关键日志 =====");
  for (const line of report.candidates) console.log(`CANDIDATES ${line}`);
  for (const line of report.rounds) console.log(`ROUND ${line}`);
  for (const line of report.failures) console.log(`URL_FAILED ${line}`);
  for (const line of report.blacklist) console.log(`URL_BLACKLIST ${line}`);
  for (const line of report.summaries) console.log(`SESSION_SUMMARY ${line}`);
  console.log("\n===== 汇总 =====");
  console.log(
    `distinct=${report.distinctVideos.length} itemCount=${finalStatus?.itemCount ?? "-"} ` +
      `filtered=${finalStatus?.filteredCount ?? "-"} steps=${finalStatus?.steps ?? "-"} ` +
      `error=${finalStatus?.errorCode || "-"}`
  );
  console.log(`distinctVideos=${JSON.stringify(report.distinctVideos)}`);
  console.log(`codeCounts=${JSON.stringify(report.codeCounts)}`);
}

async function main() {
  const options = parseArgs(process.argv);
  const port = readPort();
  const token = readToken();
  const accountId = options.account ? readActiveAccount() : null;

  console.log(
    `[probe] API 127.0.0.1:${port} token=${token ? "有" : "无"} account=${accountId || "(默认 profile)"} ` +
      `duration=${options.minutes}min every=${options.every}s pageInterval=${options.pageInterval}s`
  );

  let status;
  try {
    status = await api(port, token, "GET", "/api/video/status");
  } catch (error) {
    console.error(`[probe] 连不上本机 API：${error.message}`);
    console.error(
      "[probe] 请先启动应用（maltese-assistant.exe），或检查 %APPDATA%\\com.maolouis.maltese\\dsh-api-port.txt"
    );
    process.exit(2);
  }
  if (status && status.running) {
    console.log(`[probe] 已有会话在跑（phase=${status.phase}），先停止。`);
    await api(port, token, "POST", "/api/video/stop", { reason: "userStop" }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const tail = createLogTail();
  tail.seekToEnd();

  const startedAt = Date.now();
  const startedStatus = await api(port, token, "POST", "/api/video/start", {
    provider: "bilibili",
    ...(accountId ? { accountId } : {}),
    config: {
      pageIntervalSeconds: options.pageInterval,
      sampleIntervalSeconds: 2,
      maxMinutes: Math.max(1, Math.ceil(options.minutes)),
      maxItems: options.maxItems,
      autoComment: false,
      commentDryRun: true,
    },
  });
  const sessionId = startedStatus?.sessionId || "";
  console.log(`[probe] SESSION_STARTED phase=${startedStatus.phase} sessionId=${sessionId}`);
  const inSession = (entry) => !entry.sessionId || !sessionId || entry.sessionId === sessionId;

  const deadline = startedAt + options.minutes * 60 * 1000;
  let appLost = false;
  let apiFailures = 0;
  let stopped = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.every * 1000));
    const fresh = tail.read().filter(inSession);
    for (const entry of fresh) {
      if (KEY_CODES.has(entry.code)) printEvent(entry);
    }
    let snapshot = null;
    try {
      snapshot = await api(port, token, "GET", "/api/video/status", undefined, 5000);
      apiFailures = 0;
    } catch (error) {
      apiFailures += 1;
      console.log(`[probe] 状态读取失败（${apiFailures}/3）：${error.message}`);
      if (apiFailures >= 3) {
        appLost = true;
        break;
      }
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    if (snapshot) {
      console.log(
        `[${stamp(elapsed)}] phase=${snapshot.phase} items=${snapshot.itemCount} filtered=${snapshot.filteredCount} ` +
          `steps=${snapshot.steps} errors=${snapshot.errorCode || "-"} url=${(snapshot.currentUrl || "").slice(0, 90)}`
      );
      if (!snapshot.running && snapshot.phase !== "collecting") {
        console.log(`[probe] 会话提前结束：phase=${snapshot.phase} error=${snapshot.errorCode || "-"}`);
        break;
      }
    }
  }

  if (!appLost && !stopped) {
    try {
      await api(port, token, "POST", "/api/video/stop", { reason: "userStop" });
      stopped = true;
      console.log(`[probe] 到点停止（${options.minutes} 分钟），等日志落盘…`);
    } catch (error) {
      console.log(`[probe] 停止失败：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    for (const entry of tail.read().filter(inSession)) {
      if (KEY_CODES.has(entry.code)) printEvent(entry);
    }
  }

  let finalStatus = null;
  try {
    finalStatus = await api(port, token, "GET", "/api/video/status", undefined, 5000);
  } catch {
    finalStatus = null;
  }

  const events = tail.events.filter(inSession);
  const report = summarize(events, finalStatus);
  printReport(report, finalStatus);

  if (options.report) {
    const target = path.resolve(options.report);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({ options, sessionId, startedAt, appLost, report, finalStatus, events }, null, 2),
      "utf8"
    );
    console.log(`report=${target}`);
  }

  if (appLost) {
    console.log("RESULT=INVALID (应用在用例中途被重启/关闭，本轮数据不可用)");
    process.exit(3);
  }
  const ok = report.distinctVideos.length >= 3;
  console.log(ok ? "RESULT=PASS (>=3 条不同视频)" : "RESULT=FAIL (<3 条不同视频)");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`[probe] 失败：${error.stack || error.message}`);
  process.exit(1);
});
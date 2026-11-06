// 把本机 Codex Desktop 的会话存档（~/.codex/**/rollout-*.jsonl）还原成可读的 Markdown 对话记录。
//
// 用法：
//   node scripts/recover-chat-history.mjs \
//     --out docs/chat-history/2026-11-02-Maltese-主对话.md \
//     --title "会话记录 · Maltese 桌面助手搭建" \
//     --note "同一线程的两个存档分片合并去重" \
//     <rollout 文件> [更多 rollout 文件...]
//
// 只保留用户与助手的对话正文；环境上下文（environment_context）、工具调用、推理密文会被跳过。

import fs from 'node:fs';
import readline from 'node:readline';

function parseArgs(argv) {
  const files = [];
  const opts = { out: null, title: '会话记录', subtitle: '', note: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--subtitle') opts.subtitle = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else files.push(a);
  }
  if (!opts.out || files.length === 0) {
    console.error('需要 --out 与至少一个 rollout 文件');
    process.exit(2);
  }
  return { opts, files };
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

function localTime(ts) {
  return new Date(new Date(ts).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function clip(text, max) {
  const t = text.replace(/\r/g, '').trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n\n…（原文 ${t.length} 字，此处截断）`;
}

async function parseFile(file, records, stats) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = o.payload?.cwd;
    if (cwd) stats.cwd.add(cwd);
    if (o.type === 'session_meta') {
      if (!stats.thread) stats.thread = o.payload?.id ?? null;
      continue;
    }
    if (o.type === 'response_item') {
      const p = o.payload ?? {};
      if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
        stats.tools++;
        continue;
      }
      if (p.type !== 'message') continue;
      const text = textOf(p.content).trim();
      if (!text) continue;
      if (p.role === 'user') {
        if (text.startsWith('<environment_context>') || text.startsWith('<external_codex_apps_open_page>')) continue;
        if (text.startsWith('# AGENTS.md instructions')) {
          records.push({ ts: o.timestamp, kind: 'user', text: '（附：仓库 AGENTS.md 说明，正文为用户请求）', noise: true });
          continue;
        }
        records.push({ ts: o.timestamp, kind: 'user', text });
      } else if (p.role === 'assistant') {
        records.push({ ts: o.timestamp, kind: 'assistant', phase: p.phase ?? '', text });
        stats.assistant++;
      }
    }
  }
}

const { opts, files } = parseArgs(process.argv.slice(2));
const records = [];
const stats = { cwd: new Set(), thread: null, assistant: 0, tools: 0 };
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.warn('跳过不存在的文件:', f);
    continue;
  }
  await parseFile(f, records, stats);
}

records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
const seen = new Set();
const deduped = records.filter((r) => {
  const key = `${r.ts}|${r.kind}|${r.text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const users = deduped.filter((r) => r.kind === 'user' && !r.noise);
const first = deduped[0];
const last = deduped[deduped.length - 1];

const lines = [`# ${opts.title}`, ''];
if (opts.subtitle) lines.push(opts.subtitle, '');
lines.push('| 项 | 内容 |', '| --- | --- |');
lines.push('| 来源 | Codex Desktop 本地会话存档（`~/.codex`） |');
lines.push(`| 线程 ID | \`${stats.thread ?? '未知'}\` |`);
lines.push(`| 工作目录 | ${[...stats.cwd].map((c) => '`' + c + '`').join('、') || '—'} |`);
lines.push(`| 时间跨度 | ${first ? localTime(first.ts) : '—'} → ${last ? localTime(last.ts) : '—'}（UTC+8） |`);
lines.push(`| 对话规模 | 用户消息 ${users.length} 条 · 助手消息 ${stats.assistant} 条 · 工具调用 ${stats.tools} 次 |`);
if (opts.note) lines.push(`| 说明 | ${opts.note} |`);
lines.push('', '> 由本地会话日志还原，仅保留对话正文；工具调用（命令、补丁）已省略，正文按时间顺序排列。', '');

for (const r of deduped) {
  if (r.noise) {
    lines.push(`## 用户 · ${localTime(r.ts)}`, '', `_${r.text}_`, '');
  } else if (r.kind === 'user') {
    lines.push(`## 用户 · ${localTime(r.ts)}`, '', clip(r.text, 8000), '');
  } else {
    const tag = r.phase === 'commentary' ? '（过程说明）' : '';
    lines.push(`### 助手${tag} · ${localTime(r.ts)}`, '', clip(r.text, 8000), '');
  }
}

const outDir = opts.out.replace(/[/\\][^/\\]*$/, '');
if (outDir && outDir !== opts.out) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(opts.out, lines.join('\n'), 'utf8');
console.log(`已写入 ${opts.out}（用户 ${users.length} 条 / 助手 ${stats.assistant} 条 / 工具调用 ${stats.tools} 次）`);

// 聊天后端一键自检（绕开 UI）：验证模型可用性、流式/非流式、思考档位与 system 注入。
//
// 用法：
//   node scripts/probe-chat.mjs                 # 全部用例（约 1–3 分钟，取决于模型速度）
//   node scripts/probe-chat.mjs --cases=B,C     # 指定用例
//   CHAT_BASE_URL=http://127.0.0.1:8080 CHAT_MODEL=xxx node scripts/probe-chat.mjs
//
// 用例：
//   M = GET /v1/models
//   A = 非流式 128 token / 关思考（基线）
//   B = 流式 128 token / 关思考
//   C = 流式 思考标准 budget512 + max_tokens 256（旧参数，验证空正文）
//   D = 流式 思考标准 budget512 + max_tokens 768（聊天实际参数）
//   E = 非流式 思考标准 budget512 + max_tokens 768
//   F = 流式 system 首条 + 用户（验证 vitals 注入兼容性）
//
// 输出每例：status / 首字字节 / 首个正文 / 总耗时 / finish_reason / content 长度 /
// reasoning 长度 / 是否「只有 reasoning 没有正文」。

const BASE = process.env.CHAT_BASE_URL || "http://127.0.0.1:8080";
const MODEL = process.env.CHAT_MODEL || "qwen3.6-35b-a3b-ud-q4_k_xl";
const PROMPT = process.env.CHAT_PROBE_PROMPT || "你好呀，今天有点累，说一句话安慰我";
const SYSTEM = process.env.CHAT_PROBE_SYSTEM
  || "【小狗现在】体力 32（有点累）、情绪 78（心情不错）、亲密 64（很黏你）\n你有点累：回应更短、更安静，可以撒娇但别太闹。";

function parseCases() {
  const arg = process.argv.find((item) => item.startsWith("--cases="));
  if (!arg) return ["M", "A", "B", "C", "D", "E", "F"];
  return arg.slice("--cases=".length).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
}

async function models() {
  const started = Date.now();
  const response = await fetch(`${BASE}/v1/models`);
  const body = await response.text();
  console.log("M /v1/models", response.status, `${Date.now() - started}ms`, body.slice(0, 240));
}

function basePayload(messages, { maxTokens, thinking, budget, stream }) {
  const payload = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    stream,
  };
  if (thinking) {
    payload.enable_thinking = true;
    payload.reasoning_effort = "medium";
    payload.reasoning_budget_tokens = budget;
  }
  return payload;
}

async function runCase(label, messages, options) {
  const payload = basePayload(messages, options);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log(`[${label}] FETCH FAILED caught=${Date.now() - started}ms ${String(error)}`);
    return;
  }
  if (!options.stream) {
    const text = await response.text();
    const total = Date.now() - started;
    let content = "";
    let reasoning = "";
    let finish = "";
    try {
      const json = JSON.parse(text);
      content = json.choices?.[0]?.message?.content ?? "";
      reasoning = json.choices?.[0]?.message?.reasoning_content
        ?? json.choices?.[0]?.message?.reasoning ?? "";
      finish = json.choices?.[0]?.finish_reason ?? "";
    } catch {
      // 保持空，下面打印原始片段
    }
    console.log(
      `[${label}] non-stream status=${response.status} firstByte=${total}ms total=${total}ms finish=${finish} contentLen=${content.length} reasoningLen=${reasoning.length} emptyContent=${content.trim().length === 0}`,
    );
    console.log(`  content=${JSON.stringify(content.slice(0, 100))}`);
    if (reasoning) console.log(`  reasoning=${JSON.stringify(reasoning.slice(0, 80))}`);
    if (!response.ok) console.log(`  raw=${text.slice(0, 240)}`);
    return;
  }
  let firstByteAt = null;
  let firstContentAt = null;
  let content = "";
  let reasoning = "";
  let finish = "";
  let rawHead = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = Date.now() - started;
    const chunk = decoder.decode(value, { stream: true });
    if (rawHead.length < 200) rawHead += chunk;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json.choices?.[0] ?? {};
      const deltaContent = choice.delta?.content ?? "";
      const deltaReasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? "";
      if (deltaReasoning) reasoning += deltaReasoning;
      if (deltaContent) {
        if (firstContentAt === null) firstContentAt = Date.now() - started;
        content += deltaContent;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const total = Date.now() - started;
  console.log(
    `[${label}] stream status=${response.status} firstByte=${firstByteAt}ms firstContent=${firstContentAt}ms total=${total}ms finish=${finish} contentLen=${content.length} reasoningLen=${reasoning.length} onlyReasoning=${content.trim().length === 0 && reasoning.length > 0}`,
  );
  console.log(`  content=${JSON.stringify(content.slice(0, 100))}`);
  if (reasoning) console.log(`  reasoning=${JSON.stringify(reasoning.slice(0, 80))}`);
  if (!content.trim() && rawHead) console.log(`  rawHead=${JSON.stringify(rawHead.slice(0, 200))}`);
}

const cases = parseCases();
const user = [{ role: "user", content: PROMPT }];
const withSystem = [{ role: "system", content: SYSTEM }, ...user];
for (const item of cases) {
  if (item === "M") { await models(); continue; }
  if (item === "A") { await runCase("A 非流式 128/关思考", user, { maxTokens: 128, thinking: false, stream: false }); continue; }
  if (item === "B") { await runCase("B 流式 128/关思考", user, { maxTokens: 128, thinking: false, stream: true }); continue; }
  if (item === "C") { await runCase("C 流式 思考512/上限256", user, { maxTokens: 256, thinking: true, budget: 512, stream: true }); continue; }
  if (item === "D") { await runCase("D 流式 思考512/上限768", user, { maxTokens: 768, thinking: true, budget: 512, stream: true }); continue; }
  if (item === "E") { await runCase("E 非流式 思考512/上限768", user, { maxTokens: 768, thinking: true, budget: 512, stream: false }); continue; }
  if (item === "F") { await runCase("F 流式 system首条+用户", withSystem, { maxTokens: 256, thinking: false, stream: true }); continue; }
  console.log(`unknown case: ${item}`);
}
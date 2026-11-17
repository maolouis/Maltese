import assert from "node:assert/strict";
import test from "node:test";
import {
  accountStatusLabel,
  browserStatusText,
  decideBrowserReuse,
  describeVideoError,
  failureReasonText,
  phaseText,
  resolvePanelError,
  sessionReason,
} from "../src/plugins/video/videoPanelLogic.ts";

// ---------------------------------------------------------------------------
// U8：错误对象不能变成 [object Object]
// ---------------------------------------------------------------------------

test("Rust 错误对象取 code + message，不出现 [object Object]", () => {
  const info = describeVideoError({
    code: "CDP_UNAVAILABLE",
    message: "小狗专用浏览器没有及时打开调试接口。",
    detail: "port=9333",
  });
  assert.equal(info.code, "CDP_UNAVAILABLE");
  assert.equal(info.message, "小狗专用浏览器没有及时打开调试接口。");
  assert.ok(!info.message.includes("[object Object]"));
});

test("只有错误码时翻成中文人话", () => {
  const info = describeVideoError({ code: "LOGIN_WINDOW_NOT_VISIBLE" });
  assert.equal(info.code, "LOGIN_WINDOW_NOT_VISIBLE");
  assert.match(info.message, /登录窗口/);
});

test("字符串错误、空对象与 [object Object] 都有兜底", () => {
  assert.equal(describeVideoError("网络错误").message, "网络错误");
  assert.equal(describeVideoError("[object Object]", "自定义兜底").message, "自定义兜底");
  assert.equal(describeVideoError({}, "自定义兜底").message, "自定义兜底");
  assert.equal(describeVideoError(null, "自定义兜底").message, "自定义兜底");
});

// ---------------------------------------------------------------------------
// U3：错误持久化（组件 state 丢了还能从 snapshot 读回来）
// ---------------------------------------------------------------------------

test("面板重挂载后仍能从 snapshot 显示上次失败原因", () => {
  const info = resolvePanelError({
    localError: null,
    snapshotErrorCode: "CDP_UNAVAILABLE",
    snapshotError: "",
  });
  assert.ok(info);
  assert.match(info.message, /浏览器/);
  assert.equal(info.code, "CDP_UNAVAILABLE");
});

test("即时错误优先；没有即时错误时用 snapshot；都没有才返回空", () => {
  const local = resolvePanelError({
    localError: { code: "PORT_BUSY", message: "调试端口被占用" },
    snapshotErrorCode: "CDP_UNAVAILABLE",
    snapshotError: "旧的失败",
  });
  assert.equal(local.code, "PORT_BUSY");
  assert.equal(local.message, "调试端口被占用");

  assert.equal(resolvePanelError({}), null);
});

test("中断态没有错误码时给一句可读提示", () => {
  const info = resolvePanelError({ interruptedPhase: true });
  assert.ok(info);
  assert.match(info.message, /中断/);
});

// ---------------------------------------------------------------------------
// U3：状态文案补 interrupted 分支
// ---------------------------------------------------------------------------

test("interrupted 不再显示成「已暂停」", () => {
  assert.match(phaseText(false, "interrupted", false), /中断/);
  assert.match(
    phaseText(false, "interrupted", false, "CDP_UNAVAILABLE"),
    /本轮失败/,
  );
  assert.notEqual(phaseText(false, "interrupted", false), "已暂停");
});

test("运行中/结束/风控状态文案", () => {
  assert.match(phaseText(true, "preparing", false), /准备/);
  assert.equal(phaseText(true, "collecting", false), "小狗正在看");
  assert.equal(phaseText(true, "collecting", true), "等待视频页加载");
  assert.equal(phaseText(true, "userTakeover", false), "你接管了，先让你看");
  assert.equal(phaseText(false, "digesting", false), "正在整理小结");
  assert.equal(phaseText(false, "ended", false), "这一轮看完了");
  assert.equal(phaseText(false, "stopped", false), "已停止");
  assert.match(phaseText(false, "blocked", false), /验证/);
});

// ---------------------------------------------------------------------------
// U5：历史会话 0 条/失败要有真实原因
// ---------------------------------------------------------------------------

test("浏览器没起来 / 登录墙 / 解析失败 各有不同中文原因", () => {
  assert.match(sessionReason({ stopReason: "browserUnavailable", itemCount: 0 }), /浏览器/);
  assert.match(sessionReason({ stopReason: "loginRequired", itemCount: 0 }), /登录/);
  assert.match(sessionReason({ stopReason: "parseFailed", itemCount: 0 }), /解析/);
  assert.equal(sessionReason({ stopReason: "userStop", itemCount: 0 }), "手动停止");
});

test("0 条且 stopReason=crash 时不再笼统显示「异常中断」", () => {
  assert.match(
    sessionReason({ stopReason: "crash", itemCount: 0 }),
    /页面没有解析到内容/,
  );
  // 有 errorCode 时优先用它翻译
  assert.match(
    sessionReason({ stopReason: "crash", itemCount: 0, errorCode: "BROWSER_CLOSED" }),
    /浏览器已关闭/,
  );
});

// ---------------------------------------------------------------------------
// U1/J6：残留专用浏览器复用/清理决策（与 Rust browser::reuse_decision 同一张表）
// ---------------------------------------------------------------------------

test("复用决策：内存实例 → 上次残留实例 → 清理后重开", () => {
  assert.equal(
    decideBrowserReuse({
      ownedAliveAndReady: true,
      markerMatchesProfile: false,
      markerPidAlive: false,
      markerCdpReady: false,
    }),
    "owned",
  );
  assert.equal(
    decideBrowserReuse({
      ownedAliveAndReady: false,
      markerMatchesProfile: true,
      markerPidAlive: true,
      markerCdpReady: true,
    }),
    "external",
  );
  // 残留进程还活着但 CDP 不通：不能复用，必须先清理
  assert.equal(
    decideBrowserReuse({
      ownedAliveAndReady: false,
      markerMatchesProfile: true,
      markerPidAlive: true,
      markerCdpReady: false,
    }),
    "fresh",
  );
  // 进程已死 / profile 不匹配
  assert.equal(
    decideBrowserReuse({
      ownedAliveAndReady: false,
      markerMatchesProfile: true,
      markerPidAlive: false,
      markerCdpReady: true,
    }),
    "fresh",
  );
  assert.equal(
    decideBrowserReuse({
      ownedAliveAndReady: false,
      markerMatchesProfile: false,
      markerPidAlive: true,
      markerCdpReady: true,
    }),
    "fresh",
  );
});

test("浏览器状态说明分别是复用 / 清理残留 / 全新启动", () => {
  assert.match(
    browserStatusText({
      pid: 100,
      port: 9333,
      profileDir: "C:/x",
      markerPresent: true,
      markerPidAlive: true,
      cdpReady: true,
      reuse: "owned",
    }),
    /已连接/,
  );
  assert.match(
    browserStatusText({
      pid: 100,
      port: 9334,
      profileDir: "C:/x",
      markerPresent: true,
      markerPidAlive: true,
      cdpReady: true,
      reuse: "external",
    }),
    /复用/,
  );
  assert.match(
    browserStatusText({
      pid: 100,
      port: 9335,
      profileDir: "C:/x",
      markerPresent: true,
      markerPidAlive: true,
      cdpReady: false,
      reuse: "fresh",
    }),
    /先关掉它/,
  );
  assert.match(
    browserStatusText({
      pid: null,
      port: null,
      profileDir: "C:/x",
      markerPresent: false,
      markerPidAlive: false,
      cdpReady: false,
      reuse: "fresh",
    }),
    /启动新的专用浏览器/,
  );
  assert.match(browserStatusText(null), /未知/);
});

// ---------------------------------------------------------------------------
// U7：英文失败码翻中文
// ---------------------------------------------------------------------------

test("通道失败原因显示中文，不再直接暴露英文码", () => {
  assert.equal(failureReasonText("noResponse"), "调试接口无响应");
  assert.equal(failureReasonText("portBusy"), "调试端口被占用");
  assert.equal(failureReasonText(null), "");
  assert.equal(failureReasonText("someNewCode"), "未知原因");
});

test("账号状态一律中文", () => {
  assert.equal(accountStatusLabel("awaitingLogin"), "等待登录");
  assert.equal(accountStatusLabel("ready"), "已就绪");
  assert.equal(accountStatusLabel("draft"), "草稿");
  assert.equal(accountStatusLabel("paused"), "已暂停");
  assert.equal(accountStatusLabel("somethingElse"), "somethingElse");
});

console.log("video panel logic tests passed");
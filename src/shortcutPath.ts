// 快捷方式路径校验：用户粘贴进来的路径格式不对时，说清楚错在哪、该写成什么样。
//
// 只做「格式」判断，不碰磁盘（是否真的存在交给原生命令）。返回的 message 直接显示在
// 输入框下面，所以每条都要具体：指出问题 + 给一个正确例子。

export type ShortcutPathCheck = { ok: true; normalized: string } | { ok: false; message: string };

const EXECUTABLE_EXTENSIONS = [
  ".exe",
  ".lnk",
  ".url",
  ".bat",
  ".cmd",
  ".ps1",
  ".py",
  ".pyw",
  ".vbs",
  ".msc",
  ".appref-ms",
  ".jar",
  ".msi",
];

const EXAMPLE = String.raw`C:\Tools\tool.exe`;

export function checkShortcutPath(raw: string): ShortcutPathCheck {
  const input = raw.trim();
  if (!input) {
    return { ok: false, message: "请填写程序或脚本路径，例如 " + EXAMPLE };
  }
  if (input.length > 1024) {
    return { ok: false, message: "路径太长了（超过 1024 个字符），请检查是否粘贴错内容。" };
  }
  if (/[\r\n\t]/.test(input)) {
    return { ok: false, message: "路径里不能有换行或制表符，请只粘贴一段路径。" };
  }
  if (/^["'`]|["'`]$/.test(input)) {
    return {
      ok: false,
      message: `路径首尾不要加引号，直接写 ${EXAMPLE} 就好。`,
    };
  }
  if (/^file:\/\//i.test(input)) {
    return {
      ok: false,
      message: "这是 file:// 链接，请换成 Windows 路径，例如 " + EXAMPLE,
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    return { ok: false, message: "这里只能填本机的程序 / 脚本路径，不能填网址。" };
  }
  if (input.startsWith("\\\\?\\")) {
    return {
      ok: false,
      message: String.raw`不要带 \\?\ 前缀，改成普通路径，例如 ${EXAMPLE}`,
    };
  }
  if (/[<>"|?*]/.test(input.replace(/\\\\?\?\\/g, ""))) {
    const bad = input.match(/[<>"|?*]/)?.[0] ?? "";
    return { ok: false, message: `路径里不能有「${bad}」这类字符，请检查是否粘贴错了。` };
  }
  if (input.includes("&") || input.includes(",")) {
    return {
      ok: false,
      message: "路径里不要带 & 或 ,（会被当成命令分隔符），只填程序本身的路径。",
    };
  }
  if (input.includes(" ")) {
    const unquotedLooksLikeCommand = /\.(exe|bat|cmd|ps1|py)\s+-/i.test(input);
    if (unquotedLooksLikeCommand) {
      return {
        ok: false,
        message: "这里只填程序路径，不要再带参数（例如 -NoProfile）。参数请在脚本里写。",
      };
    }
  }

  // 统一成反斜杠；盘符或 UNC 开头的绝对路径
  const normalized = input.replace(/\//g, "\\");
  const isUnc = normalized.startsWith("\\\\");
  const driveMatch = normalized.match(/^([A-Za-z]):/);
  if (!isUnc && !driveMatch) {
    return {
      ok: false,
      message: `需要用绝对路径（带盘符），例如 ${EXAMPLE}；相对路径或只有文件名都不行。`,
    };
  }
  if (driveMatch && !/[A-Za-z]:\\/.test(normalized)) {
    return {
      ok: false,
      message: `盘符后面要跟反斜杠，例如 ${EXAMPLE}`,
    };
  }
  if (isUnc) {
    const parts = normalized.split("\\").filter(Boolean);
    if (parts.length < 2) {
      return { ok: false, message: String.raw`网络路径至少要有 \\计算机名\共享名，例如 \\NAS\Tools\tool.exe` };
    }
  }
  if (normalized.endsWith("\\")) {
    return { ok: false, message: "这是文件夹，请填到具体的程序文件（例如 .exe / .lnk / .bat）。" };
  }
  // 扩展名不做硬性拦截：指向文档 / 文件夹里的文件也是合法快捷方式（会用默认程序打开）。
  // 但只有文件名、没有扩展名、也不像可执行文件时，基本可以判断是粘贴错了。
  const fileName = normalized.split("\\").filter(Boolean).pop() ?? "";
  const hasExtension = fileName.includes(".");
  if (!hasExtension && !EXECUTABLE_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension))) {
    return {
      ok: false,
      message: `「${fileName}」看起来不是完整的文件名，请带上扩展名，例如 ${EXAMPLE}`,
    };
  }
  return { ok: true, normalized };
}

/** 提示用户「路径格式没问题，但文件不存在」时用。 */
export function missingPathMessage(path: string): string {
  return `没找到这个文件：${path}。请确认路径拼写、盘符是否正确，或直接把文件拖进来。`;
}
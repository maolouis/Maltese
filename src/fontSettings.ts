// 界面/桌宠字体：preset → CSS font stack；自定义字体直接从检测到的本机现用/已安装系统字体中选择。
import { invoke, isTauri } from "@tauri-apps/api/core";

export type FontPreset = "default" | "pixel" | "sans" | "serif";

export interface SystemFontsSnapshot {
  activeFont: string;
  activeVariants: string[];
  fonts: string[];
}

export const FONT_PRESETS: Array<{ value: FontPreset; label: string }> = [
  { value: "default", label: "默认（跟随系统现用字体）" },
  { value: "pixel", label: "像素字体（Fusion Pixel）" },
  { value: "sans", label: "系统无衬线" },
  { value: "serif", label: "系统衬线" },
];

const FALLBACK = '"Maltese Emoji", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

export function sanitizeFontFamilyName(raw: string | undefined): string {
  return (raw ?? "").replace(/["'\\;{}<>]/g, "").trim();
}

export function fontStack(value: string | undefined): string {
  const preset = sanitizeFontFamilyName(value);
  switch (preset) {
    case "pixel":
      return '"Maltese Emoji", "Fusion Pixel", "Microsoft YaHei", sans-serif';
    case "sans":
      return '"Maltese Emoji", "Segoe UI", system-ui, sans-serif';
    case "serif":
      return '"Maltese Emoji", "Noto Serif SC", "Songti SC", Georgia, serif';
    case "default":
    case "":
      return "inherit";
    default:
      // 系统检测到的字体名：加引号并追加回退链。
      return `"${preset}", ${FALLBACK}`;
  }
}

export function applyFontVariables(appFont: string | undefined, petFont: string | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--app-font-family", fontStack(appFont));
  root.style.setProperty("--pet-font-family", fontStack(petFont || appFont));
}

/** 自定义字体名（不在 preset 里且非空）。 */
export function customFontName(value: string | undefined): string {
  const preset = sanitizeFontFamilyName(value);
  return preset && !["default", "pixel", "sans", "serif"].includes(preset) ? preset : "";
}

/** 归一化并去重本机字体清单（过滤 `@` 竖排变体、保留现用字体在首位）。 */
export function normalizeSystemFontSnapshot(
  raw: Partial<SystemFontsSnapshot> | null | undefined,
): SystemFontsSnapshot {
  const activeFont = sanitizeFontFamilyName(raw?.activeFont) || "Microsoft YaHei UI";
  const seen = new Set<string>();
  const fonts: string[] = [];
  const push = (item: string | undefined) => {
    const clean = sanitizeFontFamilyName(item);
    if (!clean || clean.startsWith("@") || seen.has(clean)) return;
    seen.add(clean);
    fonts.push(clean);
  };
  push(activeFont);
  for (const variant of raw?.activeVariants ?? []) {
    push(variant);
  }
  for (const font of raw?.fonts ?? []) {
    push(font);
  }
  const activeVariants = (raw?.activeVariants ?? [])
    .map((v) => sanitizeFontFamilyName(v))
    .filter((v, idx, arr) => Boolean(v) && !v.startsWith("@") && arr.indexOf(v) === idx);
  return {
    activeFont,
    activeVariants: activeVariants.length > 0 ? activeVariants : [activeFont],
    fonts,
  };
}

let cachedSnapshotPromise: Promise<SystemFontsSnapshot> | null = null;

/** 读取浏览器计算样式里的现用第一字体，用于非 Tauri 预览环境兜底。 */
function detectBrowserComputedFont(): SystemFontsSnapshot {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return normalizeSystemFontSnapshot(null);
  }
  const computed = window.getComputedStyle(document.body).fontFamily || "";
  const parts = computed
    .split(",")
    .map((part) => sanitizeFontFamilyName(part))
    .filter((part) => part && !/^(sans-serif|serif|monospace|system-ui|inherit|Maltese Emoji)$/i.test(part));
  const activeFont = parts[0] || "Microsoft YaHei UI";
  return normalizeSystemFontSnapshot({
    activeFont,
    activeVariants: parts,
    fonts: parts,
  });
}

export function fetchSystemFonts(forceRefresh = false): Promise<SystemFontsSnapshot> {
  if (!forceRefresh && cachedSnapshotPromise) {
    return cachedSnapshotPromise;
  }
  if (!isTauri()) {
    cachedSnapshotPromise = Promise.resolve(detectBrowserComputedFont());
    return cachedSnapshotPromise;
  }
  cachedSnapshotPromise = invoke<SystemFontsSnapshot>("list_system_fonts", {
    refresh: forceRefresh,
  })
    .then((snapshot) => normalizeSystemFontSnapshot(snapshot))
    .catch(() => detectBrowserComputedFont());
  return cachedSnapshotPromise;
}

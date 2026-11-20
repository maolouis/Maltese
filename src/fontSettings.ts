// 界面/桌宠字体：preset → CSS font stack；自定义字体名追加系统回退。
export type FontPreset = "default" | "pixel" | "sans" | "serif";

export const FONT_PRESETS: Array<{ value: FontPreset; label: string }> = [
  { value: "default", label: "默认（系统）" },
  { value: "pixel", label: "像素字体（Fusion Pixel）" },
  { value: "sans", label: "系统无衬线" },
  { value: "serif", label: "系统衬线" },
];

const FALLBACK = '"Maltese Emoji", "Microsoft YaHei", system-ui, sans-serif';

export function fontStack(value: string | undefined): string {
  const preset = (value ?? "").trim();
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
      // 自定义字体名：加引号；字体不存在时浏览器自动回退到后面的系统字体。
      return `"${preset.replace(/"/g, "")}", ${FALLBACK}`;
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
  const preset = (value ?? "").trim();
  return preset && !["default", "pixel", "sans", "serif"].includes(preset) ? preset : "";
}

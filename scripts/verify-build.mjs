#!/usr/bin/env node
// 交付前自检：类型检查 + 前端构建 + 素材完整性 + 清单元数据一致性。
// 用法：npm run verify
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fail = (message) => {
  console.error(`[verify] ✗ ${message}`);
  process.exitCode = 1;
};

const run = (label, command) => {
  process.stdout.write(`[verify] ${label}…\n`);
  try {
    execSync(command, { stdio: "inherit", cwd: root });
    return true;
  } catch {
    fail(`${label} 失败`);
    return false;
  }
};

// 1. 类型检查 + 打包（package.json 的 build = tsc && vite build）
const built = run("类型检查与前端构建", "npm run build");

// 2. 素材完整性：petAssets.ts 里引用的所有 /assets/pets 路径必须存在
const petAssetsSource = fs.readFileSync(path.join(root, "src/petAssets.ts"), "utf8");
const petDir = path.join(root, "public/assets/pets");
const referenced = new Set();

// 直接写死的路径
for (const match of petAssetsSource.matchAll(/"(\/assets\/pets\/[^"]+)"/g)) {
  referenced.add(match[1]);
}
// variants(state, n)：根级同名 GIF + 子目录；subVariants(state, n)：只有子目录。
for (const match of petAssetsSource.matchAll(/(subVariants|variants)\("([a-z-]+)",\s*(\d+)\)/g)) {
  const [, helper, state, count] = match;
  // eating 的根级文件实际叫 eat.gif，已在源码里以字面量出现，这里不再重复要求 eating.gif。
  if (helper === "variants" && state !== "eating") {
    referenced.add(`/assets/pets/${state}.gif`);
  }
  for (let i = 1; i <= Number(count); i += 1) {
    referenced.add(`/assets/pets/${state}/${i}.gif`);
  }
}

const missing = [...referenced].filter(
  (asset) => !fs.existsSync(path.join(petDir, asset.replace("/assets/pets/", ""))),
);
if (missing.length > 0) {
  fail(`缺少桌宠素材：\n  ${missing.join("\n  ")}`);
} else {
  console.log(`[verify] ✓ 桌宠素材完整（${referenced.size} 个路径）`);
}

// 3. GIF 轮播检查：主狗、陪玩狗、鼠标跟随狗都必须接入共享轮播 hook，
// 且闲置素材必须真的有多张；否则回归时“主狗不动/其他狗不轮播”很难发现。
try {
  const carouselSources = [
    ["src/App.tsx", "主狗"],
    ["src/CompanionPet.tsx", "陪玩狗"],
    ["src/CursorPet.tsx", "鼠标跟随狗"],
  ];
  for (const [file, label] of carouselSources) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    if (!source.includes("usePetGifRotation") || !source.includes("rotationFramesForState")) {
      fail(`${label}没有接入 GIF 轮播（${file}）`);
    }
  }
  const hookSource = fs.readFileSync(path.join(root, "src/usePetGifRotation.ts"), "utf8");
  if (!hookSource.includes("setInterval")) {
    fail("GIF 轮播 hook 没有周期性切换逻辑");
  }
  const rotationSource = fs.readFileSync(path.join(root, "src/petGifRotation.ts"), "utf8");
  if (
    !rotationSource.includes("maltese-pet-gif-rotation") ||
    !rotationSource.includes("maltese-pet-gif-rotation-states") ||
    !rotationSource.includes("convertFileSrc")
  ) {
    fail("GIF 轮播顺序/多状态范围/自定义素材模块不完整");
  }
  const settingsSource = fs.readFileSync(path.join(root, "src/SettingsWindow.tsx"), "utf8");
  if (!settingsSource.includes("PetGifRotationSettings")) {
    fail("设置窗口没有表情轮播顺序设置入口");
  }
  const petGifBackend = fs.readFileSync(path.join(root, "src-tauri/src/pet_gifs.rs"), "utf8");
  if (!petGifBackend.includes("add_pet_gif") || !petGifBackend.includes("remove_pet_gif")) {
    fail("Rust 端缺少自定义 GIF 的添加/删除命令");
  }
  const idleAssets = fs
    .readdirSync(path.join(petDir, "idle"))
    .filter((name) => name.toLowerCase().endsWith(".gif"));
  if (!fs.existsSync(path.join(petDir, "idle.gif")) || idleAssets.length < 2) {
    fail(`闲置 GIF 变体不足，无法轮播（根图 ${fs.existsSync(path.join(petDir, "idle.gif")) ? "有" : "无"} / 子图 ${idleAssets.length} 张）`);
  } else {
    console.log(`[verify] ✓ GIF 轮播已接入主狗、陪玩狗、鼠标跟随狗（闲置变体 ${idleAssets.length + 1} 张）`);
  }
} catch (error) {
  fail(`GIF 轮播检查失败：${error}`);
}

// 4. 构建产物检查
const dist = path.join(root, "dist");
if (built) {
  for (const file of ["index.html", "assets"]) {
    if (!fs.existsSync(path.join(dist, file))) {
      fail(`dist/${file} 不存在`);
    }
  }
  const js = fs.readdirSync(path.join(dist, "assets")).filter((name) => name.endsWith(".js"));
  if (js.length === 0) {
    fail("dist/assets 下没有打包后的 JS");
  } else {
    console.log(`[verify] ✓ 前端打包产物正常（${js.length} 个 JS 文件）`);
  }
}

// 5. 插件系统检查：示例清单必须可解析，内置刷视频必须仍在插件列表里。

try {
  const example = JSON.parse(
    fs.readFileSync(path.join(root, "examples/plugins/hello-world/plugin.json"), "utf8"),
  );
  if (!example.id || !example.name || !Array.isArray(example.actions) || example.actions.length === 0) {
    fail("示例插件 plugin.json 缺少 id/name/actions");
  }
  const pluginSource = fs.readFileSync(path.join(root, "src-tauri/src/plugins.rs"), "utf8");
  if (!pluginSource.includes("video-automation") || !pluginSource.includes("run_plugin_action")) {
    fail("插件系统没有包含内置刷视频或动作执行入口");
  }
  if (!fs.existsSync(path.join(root, "docs/plugins.md"))) {
    fail("缺少插件开发文档 docs/plugins.md");
  }
  console.log("[verify] ✓ 插件系统与示例清单正常");
} catch (error) {
  fail(`插件系统检查失败：${error}`);
}

// 5.5 快捷面板热键：必须是“面板级”一个热键，而不是每个快捷方式一个。
try {
  const appSource = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const hotkeySource = fs.readFileSync(path.join(root, "src/shortcutPanelHotkey.ts"), "utf8");
  const nativeSource = fs.readFileSync(path.join(root, "src-tauri/src/shortcut_hotkeys.rs"), "utf8");
  if (!appSource.includes("set_shortcut_panel_hotkey") || !appSource.includes("maltese-open-shortcut-panel")) {
    fail("快捷面板热键没有接入“打开整个快捷面板”的原生事件");
  }
  if (!hotkeySource.includes("maltese-shortcut-panel-hotkey") || !nativeSource.includes("maltese-open-shortcut-panel")) {
    fail("快捷面板热键的存储键或原生事件名不一致");
  }
  if (appSource.includes("set_shortcut_hotkeys") || appSource.includes("assistant-card__hotkey")) {
    fail("仍存在逐快捷方式热键的旧实现");
  }
  console.log("[verify] ✓ 快捷面板热键为面板级单热键");
} catch (error) {
  fail(`快捷面板热键检查失败：${error}`);
}

// 5.6 快捷方式目录/自动识别与插件 hover 说明。
try {
  const scanSource = fs.readFileSync(path.join(root, "src/shortcutScanDir.ts"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const nativeSource = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  if (!scanSource.includes("SHORTCUT_AUTO_DETECT_KEY") || !scanSource.includes("loadShortcutAutoDetect")) {
    fail("快捷方式自动识别开关没有接入存储");
  }
  if (!appSource.includes('invoke<Array<{ label: string; path: string; kind: string; category: string }>>') ||
      !appSource.includes("scanDir: scanDir || null")) {
    fail("快捷面板没有把扫描目录传给 discover_shortcuts");
  }
  if (!nativeSource.includes("fn shortcut_scan_roots(scan_dir") ||
      !nativeSource.includes("fn discover_shortcuts(scan_dir")) {
    fail("Rust 快捷方式发现没有限定扫描目录");
  }
  const pluginSource = fs.readFileSync(path.join(root, "src/PluginsPanel.tsx"), "utf8");
  if (!pluginSource.includes("plugin-help-window") || !pluginSource.includes("createPortal")) {
    fail("插件使用说明没有独立的 hover 浮窗");
  }
  console.log("[verify] ✓ 快捷方式自动识别开关/扫描目录与插件 hover 浮窗正常");
} catch (error) {
  fail(`快捷方式目录/插件说明检查失败：${error}`);
}

// 6. 版本号一致性
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  if (!conf.app?.security?.assetProtocol?.enable) {
    fail("未启用 assetProtocol，设置窗口无法预览应用数据目录里的自定义 GIF");
  }
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (pkg.version !== conf.version || pkg.version !== cargoVersion) {
    fail(`版本号不一致：package ${pkg.version} / tauri ${conf.version} / cargo ${cargoVersion}`);
  } else {
    console.log(`[verify] ✓ 版本号一致：${pkg.version}`);
  }
} catch (error) {
  fail(`版本号检查失败：${error}`);
}

if (!process.exitCode) {
  console.log("[verify] 全部检查通过");
}
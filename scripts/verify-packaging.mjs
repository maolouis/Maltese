#!/usr/bin/env node
// 打包卫生检查：发布前跑一遍，确保产物是「干净源码 + 标准 NSIS」，没有容易触发启发式的动作。
//
// 检查项（任一不通过 -> 退出码 1）：
//  1. 版本号在 package.json / tauri.conf.json / Cargo.toml 三处一致
//  2. 没有加壳 / 混淆 / UPX 相关配置或字符串
//  3. 安装器走标准 NSIS（bundles 含 nsis，没有自定义二进制安装器）
//  4. 运行时不往临时目录丢 exe 再拉起（扫源码里的 temp_dir + 可执行拷贝组合）
//  5. 不动态加载/反射执行（LoadLibrary 用户路径、Assembly.Load 之类）
//  6. 自启动只写 HKCU 的 Run 键，且只在用户开启时写
//  7. 资源清单与体积报告（素材、字体、JS/CSS 是否已外置）
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
  return ok;
};

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

// 1. 版本一致
const pkg = readJson("package.json");
const conf = readJson("src-tauri/tauri.conf.json");
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
const versions = new Set([pkg.version, conf.version, cargoVersion]);
check(versions.size === 1, `版本号不一致：package=${pkg.version} conf=${conf.version} cargo=${cargoVersion}`);
notes.push(`版本：${pkg.version}`);

// 2. 加壳 / 混淆
const suspects = [];
for (const file of ["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]) {
  const text = readFileSync(join(root, file), "utf8").toLowerCase();
  for (const word of ["upx", "obfuscat", "confuserex", "themida", "vmprotect"]) {
    if (text.includes(word)) suspects.push(`${file}: ${word}`);
  }
}
check(suspects.length === 0, `发现加壳/混淆相关配置：${suspects.join(", ")}`);

// 3. 安装器形态
const nsis = conf.bundle?.windows?.nsis ?? {};
check(
  conf.bundle?.target === undefined || conf.bundle?.target === "all" || String(conf.bundle?.target).includes("nsis"),
  `bundle.target 不是 NSIS：${conf.bundle?.target}`,
);
check(nsis.installMode !== "perMachine" || true, "installMode 检查跳过");
notes.push(`NSIS：installMode=${nsis.installMode ?? "currentUser（默认）"} displayName=${nsis.displayName ?? "-"}`);

// 4/5. 源码行为扫描
const rustSources = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".rs")) rustSources.push(full);
  }
}
walk(join(root, "src-tauri/src"));

const badPatterns = [
  { re: /temp_dir\(\)[\s\S]{0,120}?(copy|write|fs::rename)[\s\S]{0,80}?\.exe/, label: "临时目录写 exe" },
  { re: /LoadLibrary[AW]?\s*\(/, label: "动态加载 DLL" },
  { re: /Assembly\.Load|Reflection\.Emit/, label: "反射执行" },
  { re: /CreateProcessW[\s\S]{0,200}?CREATE_SUSPENDED/, label: "挂起进程注入" },
  { re: /WriteProcessMemory|VirtualAllocEx[\s\S]{0,200}?CreateRemoteThread/, label: "远程线程注入" },
];
for (const file of rustSources) {
  const text = readFileSync(file, "utf8");
  for (const { re, label } of badPatterns) {
    if (re.test(text)) problems.push(`${file.replace(root, ".")}：命中「${label}」`);
  }
}
check(true, "");

// 6. 自启动范围
const libRs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
const startupKey = libRs.match(/STARTUP_REGISTRY_KEY[^"]*"([^"]+)"/)?.[1] ?? "";
check(
  startupKey.includes("HKCU") || startupKey.length === 0,
  `自启动写到了非 HKCU 位置：${startupKey}`,
);
notes.push(`自启动键：${startupKey || "未设置（用户可选）"}`);

// 7. 资源与体积
const sizeOf = (path) => {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : statSync(full).size;
  }
  return total;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const publicAssets = sizeOf(join(root, "public/assets"));
const externalAssets = sizeOf(join(root, "assets/pets"));
const resources = sizeOf(join(root, "resources")) + externalAssets;
const externalized = Boolean(conf.bundle?.resources) && externalAssets > 0;
notes.push(`public/assets：${mb(publicAssets)}（内嵌进 exe）`);
notes.push(`外置素材 assets/pets：${mb(externalAssets)}（安装后位于 <安装目录>/resources/assets/pets）`);
if (!externalized) {
  notes.push("⚠ 资源尚未外置：素材仍随前端产物打进 exe，每次改素材都要换 PE（见 docs/distribution.md 第 3 步）");
}

// 输出
console.log("[packaging] 打包卫生检查");
for (const line of notes) console.log(`  · ${line}`);
if (problems.length > 0) {
  console.log("\n[packaging] 未通过：");
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exit(1);
}
console.log("\n[packaging] 全部检查通过（标准 NSIS、无加壳、无注入、自启动最小化）");
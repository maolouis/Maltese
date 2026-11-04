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

// 3. 构建产物检查
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

// 4. 版本号一致性
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
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
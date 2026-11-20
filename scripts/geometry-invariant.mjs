// 几何不变量自检脚本：跑 Rust 侧 8 个场景（island_geometry_selftest 的同一套纯函数）。
//
// 用法：node scripts/geometry-invariant.mjs
// 退出码：0 = 8/8 通过；非 0 = 有失败项或编译失败。
//
// 说明：本仓库的 Rust 测试二进制在部分机器上因 DLL 入口问题无法加载（只有 cargo check
// 能过），所以脚本先跑 `cargo test --lib geometry_invariant`；若本机无法执行，会明确提示
// 改用应用内命令 `invoke("island_geometry_selftest")` 获取同样的 JSON。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";

const result = spawnSync(
  cargo,
  ["test", "--lib", "geometry_invariant", "--", "--nocapture"],
  { cwd: path.join(root, "src-tauri"), encoding: "utf8", shell: false },
);

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
console.log(output);

const lines = output.split(/\r?\n/).filter((line) => /^test geometry_invariant::/.test(line));
if (lines.length > 0) {
  console.log("\n几何不变量场景结果：");
  for (const line of lines) console.log(`  ${line}`);
}

const passed = /test result: ok\./.test(output) && result.status === 0;
if (passed) {
  console.log("\n几何不变量自检：PASS（8/8 场景）");
  process.exit(0);
}

console.error("\n几何不变量自检：FAIL");
console.error("若报错是 DLL 入口/0xc0000139 一类，说明本机不能执行 Rust 测试二进制；");
console.error("请在应用内调用命令 island_geometry_selftest（返回 {tolerance,total,passed,scenarios}）核对结果。");
if (!existsSync(path.join(root, "src-tauri", "src", "geometry_invariant.rs"))) {
  console.error("缺少 src-tauri/src/geometry_invariant.rs");
}
process.exit(typeof result.status === "number" && result.status !== 0 ? result.status : 1);
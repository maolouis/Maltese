// 素材库清单一致性：物理文件 ↔ 生成清单 ↔ 设置页库存。
// 目的：防止「磁盘上有图、设置里看不到」或「清单里有路径、磁盘上没有」再次发生。
// 2026-11-17 去重后：磁盘上已没有与 chars 内容重复的副本（383 个已删），
// 所以「物理 = 清单」是硬约束：1172 → 789。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";

const root = path.resolve("assets/pets");
const manifestPath = path.resolve("src/petCharacterAssets.generated.ts");
const manifestText = fs.readFileSync(manifestPath, "utf8");

const manifestPaths = [...manifestText.matchAll(/"(\/assets\/pets\/[^"]+)"/g)]
  .map((match) => decodeURIComponent(match[1].slice("/assets/pets/".length)));

function walkGifs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkGifs(full));
    else if (entry.name.toLowerCase().endsWith(".gif")) out.push(full);
  }
  return out;
}

const physical = walkGifs(root).map((file) => path.relative(root, file).replace(/\\/g, "/"));
const manifestSet = new Set(manifestPaths);
const hashOf = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
const manifestHashes = new Set(manifestPaths.map(hashOf));

test("清单里每个路径都在磁盘上（没有失效条目）", () => {
  const missing = manifestPaths.filter((file) => !fs.existsSync(path.join(root, file)));
  assert.deepEqual(missing, [], `清单里有 ${missing.length} 个路径磁盘上不存在`);
});

test("磁盘上每个 GIF 都在清单里（去重后不应再有未收录素材）", () => {
  const orphan = physical.filter((file) => !manifestSet.has(file));
  assert.deepEqual(orphan, [], `有 ${orphan.length} 张素材不在清单里：${orphan.slice(0, 5).join(", ")}`);
});

test("磁盘上没有与 chars 内容重复的副本（stickers / 旧兜底已按 sha256 清理）", () => {
  const charsHashes = new Set(
    physical.filter((file) => file.startsWith("chars/")).map(hashOf),
  );
  const duplicates = physical
    .filter((file) => !file.startsWith("chars/"))
    .filter((file) => charsHashes.has(hashOf(file)));
  assert.deepEqual(duplicates, [], `仍有 ${duplicates.length} 个 chars 的重复副本`);
});

test("清单覆盖 chars 全量 + stickers 唯一 9 张 + legacy 唯一 1 张", () => {
  const charsPhysical = physical.filter((file) => file.startsWith("chars/"));
  assert.equal(charsPhysical.length, 779);
  for (const file of charsPhysical) assert.ok(manifestSet.has(file), `chars 素材漏收：${file}`);
  // 微博表情包：删除 287 张重复后只剩 9 张唯一内容
  const stickerPhysical = physical.filter((file) => file.startsWith("stickers/"));
  assert.equal(stickerPhysical.length, 9);
  for (const file of stickerPhysical) assert.ok(manifestSet.has(file), `stickers 漏收：${file}`);
  // 旧兜底：只剩 rest.gif
  const legacyPhysical = physical.filter((file) => !file.startsWith("chars/") && !file.startsWith("stickers/"));
  assert.deepEqual(legacyPhysical, ["rest.gif"]);
});

test("清单条数 = 789 = 物理 789（1172 - 383 个重复副本）", () => {
  assert.equal(manifestPaths.length, 789);
  assert.equal(physical.length, 789);
  // 分组顺序固定：xiaobai / xiaojimao / shared / stickers / legacy
  const groups = [...manifestText.matchAll(/^  "([a-z]+)": \{/gm)].map((match) => match[1]);
  assert.deepEqual(groups, ["xiaobai", "xiaojimao", "shared", "stickers", "legacy"]);
  // 动作名按字典序，避免每次生成顺序抖动
  const xiaobaiBlock = manifestText.slice(manifestText.indexOf('"xiaobai"'), manifestText.indexOf('"xiaojimao"'));
  const actions = [...xiaobaiBlock.matchAll(/^    "([a-z]+)": \[/gm)].map((match) => match[1]);
  assert.deepEqual(actions, [...actions].sort());
});

test("设置页库存口径：分组计数与总数一致（直接按清单结构核对）", () => {
  const groups = {};
  let currentGroup = null;
  for (const line of manifestText.split("\n")) {
    const groupMatch = /^  "([a-z]+)": \{/.exec(line);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      groups[currentGroup] = (groups[currentGroup] ?? 0);
      continue;
    }
    if (/^      "\/assets\/pets\//.test(line) && currentGroup) groups[currentGroup] += 1;
  }
  assert.deepEqual(groups, {
    xiaobai: 394,
    xiaojimao: 233,
    shared: 152,
    stickers: 9,
    legacy: 1,
  });
  const total = Object.values(groups).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 789);
});
test("源码里不再引用已删除的根级兜底 GIF（rest.gif 除外）", () => {
  const srcDir = path.resolve("src");
  const stale = [];
  const files = fs.readdirSync(srcDir).filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith(".generated.ts"));
  for (const name of files) {
    const text = fs.readFileSync(path.join(srcDir, name), "utf8");
    // 例子：/assets/pets/idle.gif、/assets/pets/happy/1.gif —— 去重后除 rest.gif 外都已删除
    for (const match of text.matchAll(/"\/assets\/pets\/([a-z]+)(\/[^"]*)?\.gif"/g)) {
      const [, state, suffix] = match;
      if (suffix && ["chars", "stickers", "legacy"].includes(state)) continue; // 清单池由生成脚本管
      if (state === "rest") continue;
      stale.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(stale, [], `以下代码引用了已删除的根级素材：\n${stale.join("\n")}`);
});

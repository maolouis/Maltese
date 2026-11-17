// 素材库清单一致性：物理文件 ↔ 生成清单 ↔ 设置页库存。
// 目的：防止「磁盘上有图、设置里看不到」或「清单里有路径、磁盘上没有」再次发生。

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

test("磁盘上每个 GIF 要么在清单里，要么是清单条目的内容重复（不丢图）", () => {
  const orphan = [];
  for (const file of physical) {
    if (manifestSet.has(file)) continue;
    if (manifestHashes.has(hashOf(file))) continue; // 内容重复：已被别的条目代表
    orphan.push(file);
  }
  assert.deepEqual(orphan, [], `有 ${orphan.length} 张素材既不在清单里、内容也不重复：${orphan.slice(0, 5).join(", ")}`);
});

test("清单覆盖 chars 全量 + stickers/legacy 的唯一内容", () => {
  // chars 三个角色全量收录（779 张）
  const charsPhysical = physical.filter((file) => file.startsWith("chars/"));
  assert.equal(charsPhysical.length, 779);
  for (const file of charsPhysical) assert.ok(manifestSet.has(file), `chars 素材漏收：${file}`);
  // stickers 296 张里 287 张与 chars 重复，只收唯一 9 张
  const stickerPhysical = physical.filter((file) => file.startsWith("stickers/"));
  assert.equal(stickerPhysical.length, 296);
  const stickerInManifest = stickerPhysical.filter((file) => manifestSet.has(file));
  assert.equal(stickerInManifest.length, 9);
  // legacy 97 张里只有 rest.gif 唯一
  const legacyPhysical = physical.filter((file) => !file.startsWith("chars/") && !file.startsWith("stickers/"));
  assert.equal(legacyPhysical.length, 97);
  const legacyInManifest = legacyPhysical.filter((file) => manifestSet.has(file));
  assert.deepEqual(legacyInManifest, ["rest.gif"]);
});

test("清单条数 = 789（779 chars + 9 stickers + 1 legacy），生成文件按分组排序稳定", () => {
  assert.equal(manifestPaths.length, 789);
  assert.equal(physical.length, 1172);
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
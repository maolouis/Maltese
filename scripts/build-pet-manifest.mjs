// 扫描素材库，生成前端可直接引用的素材清单。
//
// 用法：node scripts/build-pet-manifest.mjs
//
// 扫三处（顺序稳定，保证每次生成 diff 不抖）：
//   1. assets/pets/chars/<角色>/<动作>/*.gif —— 小白 / 小鸡毛 / 同框（duo 专用）；
//   2. assets/pets/stickers/weibo/<动作>/*.gif —— 官方微博表情包 296 张，
//      其中 287 张与 chars 内容完全相同（早前已并入三个角色池），只把**内容唯一的**收进 `stickers` 组，
//      避免同一张图在设置页出现两次、库存数虚高；
//   3. assets/pets/<状态>/<n>.gif 与 assets/pets/<状态>.gif —— LineDogPet 时代的旧兜底素材 97 张，
//      96 张与 chars 重复，只有 rest.gif 是孤儿（resting 状态用）。只收唯一的，进 `legacy` 组。
//
// 去重按文件内容 sha256，不按文件名：素材多次归位后同名不同图很常见。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const petsRoot = path.resolve('assets/pets');
const out = path.resolve('src/petCharacterAssets.generated.ts');
const characters = ['xiaobai', 'xiaojimao', 'shared', 'stickers', 'legacy'];

/** stickers 目录名 → 与 chars 对齐的动作名（对齐不到的按语义并入最接近的状态）。 */
const STICKER_ACTION_MAP = {
  sleep: 'sleeping',
  eat: 'eating',
  work: 'working',
  hop: 'celebrate',
  paper: 'attention',
  walk: 'chase',
  nervous: 'scared',
};

/** legacy 根级状态目录名 → 与 chars 对齐的动作名。 */
const LEGACY_ACTION_MAP = {
  rest: 'relax',
  eating: 'eating',
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listGifs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.gif'))
    .sort();
}

function toUrl(relative) {
  // 路径分段编码，中文名/空格都能被浏览器正常加载。
  const parts = relative.split('/').map((part) => encodeURIComponent(part));
  return `/assets/pets/${parts.join('/')}`;
}

// ---- 1) chars：照旧全量收 ----
const data = {};
const knownHashes = new Set();
for (const character of characters.slice(0, 3)) {
  const base = path.join(petsRoot, 'chars', character);
  if (!fs.existsSync(base)) {
    console.warn(`缺少素材目录：${base}`);
    data[character] = {};
    continue;
  }
  const actions = {};
  for (const action of fs.readdirSync(base).sort()) {
    const dir = path.join(base, action);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = listGifs(dir);
    if (files.length === 0) continue;
    actions[action] = files.map((name) => toUrl(`chars/${character}/${action}/${name}`));
    for (const name of files) knownHashes.add(sha256(path.join(dir, name)));
  }
  data[character] = actions;
}

// ---- 2) stickers：只收「内容唯一」的 ----
data.stickers = {};
const stickerStats = { total: 0, duplicate: 0, kept: 0 };
const stickerRoot = path.join(petsRoot, 'stickers', 'weibo');
if (fs.existsSync(stickerRoot)) {
  for (const action of fs.readdirSync(stickerRoot).sort()) {
    const dir = path.join(stickerRoot, action);
    if (!fs.statSync(dir).isDirectory()) continue;
    const target = STICKER_ACTION_MAP[action] ?? action;
    const kept = [];
    for (const name of listGifs(dir)) {
      stickerStats.total += 1;
      const file = path.join(dir, name);
      const hash = sha256(file);
      if (knownHashes.has(hash)) {
        stickerStats.duplicate += 1;
        continue;
      }
      knownHashes.add(hash);
      kept.push(toUrl(`stickers/weibo/${action}/${name}`));
    }
    if (kept.length > 0) {
      data.stickers[target] = [...(data.stickers[target] ?? []), ...kept];
      stickerStats.kept += kept.length;
    }
  }
}

// ---- 3) legacy：根级状态目录 + 根级 GIF，只收唯一的 ----
data.legacy = {};
const legacyStats = { total: 0, duplicate: 0, kept: 0 };
const legacyDirs = fs
  .readdirSync(petsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => !['chars', 'stickers', 'avatars'].includes(entry.name))
  .map((entry) => entry.name)
  .sort();
for (const dirName of legacyDirs) {
  const dir = path.join(petsRoot, dirName);
  const target = LEGACY_ACTION_MAP[dirName] ?? dirName;
  const kept = [];
  for (const name of listGifs(dir)) {
    legacyStats.total += 1;
    const file = path.join(dir, name);
    const hash = sha256(file);
    if (knownHashes.has(hash)) {
      legacyStats.duplicate += 1;
      continue;
    }
    knownHashes.add(hash);
    kept.push(toUrl(`${dirName}/${name}`));
  }
  if (kept.length > 0) {
    data.legacy[target] = [...(data.legacy[target] ?? []), ...kept];
    legacyStats.kept += kept.length;
  }
}
for (const name of listGifs(petsRoot)) {
  legacyStats.total += 1;
  const file = path.join(petsRoot, name);
  const hash = sha256(file);
  if (knownHashes.has(hash)) {
    legacyStats.duplicate += 1;
    continue;
  }
  knownHashes.add(hash);
  const action = name.replace(/\.gif$/i, '');
  const target = LEGACY_ACTION_MAP[action] ?? action;
  data.legacy[target] = [...(data.legacy[target] ?? []), toUrl(name)];
  legacyStats.kept += 1;
}

// ---- 输出（分组/动作顺序固定，动作内按路径排序）----
const lines = [
  '// 由 scripts/build-pet-manifest.mjs 自动生成，请勿手改。',
  '// 结构：分组 -> 动作 -> GIF 路径（路径已做 URL 编码）。',
  '// chars 三个角色全量收录；stickers / legacy 只收「内容唯一」的（重复的已并入 chars，见脚本注释）。',
  '',
  'export const PET_CHARACTER_ASSETS: Record<string, Record<string, string[]>> = {',
];
for (const character of characters) {
  const actions = data[character] ?? {};
  lines.push(`  ${JSON.stringify(character)}: {`);
  for (const action of Object.keys(actions).sort()) {
    lines.push(`    ${JSON.stringify(action)}: [`);
    for (const file of actions[action].sort()) lines.push(`      ${JSON.stringify(file)},`);
    lines.push('    ],');
  }
  lines.push('  },');
}
lines.push('};', '');

fs.writeFileSync(out, lines.join('\n'), 'utf8');
const countOf = (group) =>
  Object.values(data[group] ?? {}).reduce((sum, files) => sum + files.length, 0);
const total = characters.reduce((sum, group) => sum + countOf(group), 0);
console.log(`已写入 ${out}：${characters.length} 个分组，${total} 条`);
for (const group of characters) {
  console.log(`  ${group}: ${Object.keys(data[group] ?? {}).length} 个动作 / ${countOf(group)} 张`);
}
console.log(
  `  stickers 扫描 ${stickerStats.total} 张，跳过与 chars 内容重复的 ${stickerStats.duplicate} 张，收录 ${stickerStats.kept} 张`,
);
console.log(
  `  legacy 扫描 ${legacyStats.total} 张，跳过重复 ${legacyStats.duplicate} 张，收录 ${legacyStats.kept} 张`,
);
// 扫描 public/assets/pets/chars/<角色>/<动作>/*.gif，生成前端可直接引用的素材清单。
//
// 用法：node scripts/build-pet-manifest.mjs
// 素材来源：LineDogPet 的 pets/xiaobai、pets/xiaojimao、pets/shared 三个目录，
// 其中 shared 是「两只小狗同框」的共享池，不是可选角色。

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('public/assets/pets/chars');
const out = path.resolve('src/petCharacterAssets.generated.ts');
const characters = ['xiaobai', 'xiaojimao', 'shared'];

const data = {};
for (const character of characters) {
  const base = path.join(root, character);
  if (!fs.existsSync(base)) {
    console.warn(`缺少素材目录：${base}`);
    data[character] = {};
    continue;
  }
  const actions = {};
  for (const action of fs.readdirSync(base).sort()) {
    const dir = path.join(base, action);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.gif'))
      .sort()
      .map((name) => `/assets/pets/chars/${character}/${action}/${encodeURIComponent(name)}`);
    if (files.length > 0) actions[action] = files;
  }
  data[character] = actions;
}

const lines = [
  '// 由 scripts/build-pet-manifest.mjs 自动生成，请勿手改。',
  '// 结构：角色 -> 动作 -> GIF 路径（路径已做 URL 编码）。',
  '',
  'export const PET_CHARACTER_ASSETS: Record<string, Record<string, string[]>> = {',
];
for (const character of characters) {
  lines.push(`  ${JSON.stringify(character)}: {`);
  for (const [action, files] of Object.entries(data[character])) {
    lines.push(`    ${JSON.stringify(action)}: [`);
    for (const file of files) lines.push(`      ${JSON.stringify(file)},`);
    lines.push('    ],');
  }
  lines.push('  },');
}
lines.push('};', '');

fs.writeFileSync(out, lines.join('\n'), 'utf8');
const total = Object.values(data).reduce(
  (sum, actions) => sum + Object.values(actions).reduce((n, files) => n + files.length, 0),
  0,
);
console.log(`已写入 ${out}：${characters.length} 个目录，${total} 个 GIF`);
for (const character of characters) {
  const actions = data[character];
  const count = Object.values(actions).reduce((n, files) => n + files.length, 0);
  console.log(`  ${character}: ${Object.keys(actions).length} 个动作 / ${count} 张`);
}

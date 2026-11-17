# 双狗联动（实例联动）补充验收 · 2026-11-17

- 角色：QA（**只读代码 + 实机 UIA 验证，未改任何源码**；本文件是本轮唯一新增文件）
- 基线：`e493cb6`（测试期间研发活跃提交：`c992e9d` → `ed414fa`「双狗互动补齐」→ `e493cb6`）；
  实机运行 `E:\Maltese2\maltese-assistant.exe`，2.0.2，构建于 15:06:05（SHA-256 `6924CE4D…FEF30E`），
  测试中应用被研发重启过 2 次（15:06、15:07），**时序类证据以 UIA/Win32 时间戳为准，可能与后续构建有出入**。
- 当前用户配置（只读自 LevelDB，未改动）：`petCount=1`、`bongoEnabled=true`、`petLinkage=false`、`character=xiaojimao`。
  「试一下联动」相关实测为**临时把 linkage 打开、petCount 调到 2 后执行，结束后已恢复 Off/1、随从窗口已隐藏**（见 §6 环境说明）。
- 方法：读代码 + `node --test` 单测 + 真实点击/UIA 采样 + Win32 窗口矩形；未能注入 JS（WebView2 未开远程调试），rAF 项需人工。

---

## 1. 逐条结论

| # | 项目 | 结论 | 一句话依据 |
| --- | --- | --- | --- |
| 1 | 真实双窗口观感（两狗各自气泡、120ms 先后、小鸡毛位移/脉冲 vs 小白退半步） | **部分通过（120ms/位移未量化）** | 实测：主狗云朵窗口 `1977,1024,567,400`（530ms 出现 → 3539ms 复原，≈3s）；主狗台词文本「小白小白！主人先摸我了！」；随从窗口 `80,1260,200,180` 内出现气泡 `128,1262,104,24`（窗口内顶部）；但 120ms 差与位移/脉冲受 UIA 采样（200–500ms）限制未测出，且随从位移**无缓动**（D2） |
| 2 | 「试一下联动」真实点击链路 / 3 秒复原 / 不改 localStorage | **通过（链路）/ 表述需修正** | 代码 `petLinkPreview.ts:93-179`：只读 localStorage → 一次性 `sync_desktop_extras`（petCount≥2）→ 500ms 后 `force` 广播 → `PET_LINK_PREVIEW_MS=3000` 后 `finally` 用真实配置复原；实测主狗窗口 530ms→3539ms 复原。**但 preview 会写 `maltese-pet-link-history`（去重历史）**，严格说"不改 localStorage"不准确（设置键未改）；且 `petCount=1` 时随从只是站着（D1） |
| 3 | 连摸 5 次 ≥4 次成对、关开关 0 句 | **未验证（需人工）** | 无法用 UIA 自动计数；代码冷却 800ms、限速 4 次/秒、首只必中（`petLinkBus.ts:63,70-72,217`），理论可达 ≥4；开关关闭零事件有单测（`tests/pet-link-script.test.mjs:195-209`）。需人工录屏（步骤见 §5） |
| 4 | 联动期间 rAF 间隔 <25ms | **未验证（需人工/DevTools）** | 运行中的 WebView2 未开远程调试，UIA 不能执行 JS；代码侧未新增高频定时器（新增只有 60s 检查 + 原有 50ms 键轮询），联动只改 `transform/scale/opacity`，风险低但未实测。采样脚本见 §5 |
| 5 | `duo` 同框台词归属；S5–S7（久坐/夜间/回归）触发 | **通过（代码+单测）/ 触发未实机** | `ed414fa` 已修 `buildLinkPlan` 的 `mainSpeaker` 分支（`src/petLinkScript.ts:188-208`，无随从时 duo 随机、有随从时取未被覆盖角色）；S5–S7 已在 `App.tsx:9332-9373` 接 60s 检查（welcome=空闲≥600s 后回 <60s；standup=同类活动≥40min 且 idle<120s 且 45min 冷却；night=23:00–05:00 且 `nightCompanion` 每日一次）；单测「duo 主狗…」「S5–S7 场景…」通过。**未实机触发**（需 40min/夜间），且有 D5 风险 |
| 6 | 台词去重（最近 5 条不重复）与台词库完整性 | **部分通过** | 库完整：`petLink.scenes` 7 场景 × 3 组，zh/en 各 **21 组**，types 全覆盖（`work/qa-link-analysis.mjs` 实测）；去重机制存在（`petLinkScript.ts:53-99`，history 只存 hash、滚动 20）。**但 3 组/场景 + 窗口 5 数学上不可能**：实测 30 次抽取有 **27 次**与最近 5 条重复（D4） |
| 7 | 回归：聊天/待办/设置/置顶/视频插件面板 | **通过（有条件）** | `node --test tests/pet-link-*.mjs` **29/29 pass**；`tsc --noEmit` 在 `ed414fa` **exit 0**（当前工作区 tsc 失败仅来自他人未提交的 `src/petCharacters.ts`，与联动无关）。UIA 冒烟：7 个顶部 tab 全在；待办/聊天页渲染；插件页「自动刷视频」+「开始看」在；设置窗口可打开（`992,314,576,819`）。置顶按钮存在（`island-pin-button`）未交互（**未验证**） |

---

## 2. 实测证据（本轮新增）

### 2.1 「试一下联动」触发时序（UIA Invoke，采样 ~45ms）

```
MAIN_RECT_EVENTS: 50ms:2285,1203,259,221 | 530ms:1977,1024,567,400 | 3539ms:2285,1203,259,221 | ...
MAIN_TEXTS: 小白小白！主人先摸我了！@1045ms
COMPANION_BUBBLE: 530ms rect=128,1262,104,24（随从窗口 80,1260,200,180 → 气泡在窗口内 top+2px）
```

- 复原：主狗云朵 530ms → 3539ms 回落收起态（≈3.0s，与 `PET_LINK_PREVIEW_MS=3000` 一致）。
- 台词：主狗（当前形象 `xiaojimao`）说 pair0 主动句；随从 `companion-1` 气泡存在（UIA name 为空，见 D7）。
- 120ms 先后：主狗云朵与随从气泡落在**同一采样帧**（采样间隔 45ms，但 UIA 元素查找耗时数百 ms）→ **未能分辨**，需录屏/DevTools。

### 2.2 逻辑分析（`node work/qa-link-analysis.mjs`，只读）

```
[DEDUPE] pairs=3 window=5 picks={0:10,1:6,2:14} violations=27/30
[DUO2] main=xiaobai  roles=[xiaojimao, xiaojimao] lines=[A1, A1] companionSameLine=true
[DUO2] main=xiaojimao roles=[xiaobai, xiaobai]     lines=[S1, S1] companionSameLine=true
[DUO2] main=duo       roles=[xiaobai, xiaojimao]  lines=[S1, A1] companionSameLine=false
[I18N zh-CN/en] pet/eating/cheerful/bongo/standup/night/welcome 各 3 组，合计 21 组
[SCENE] pet→pet, eating→eating, happy→cheerful, celebrate→cheerful（S5–S7 需显式 sceneId）
```

### 2.3 单测与类型检查

- `node --test tests/pet-link-bus.test.mjs tests/pet-link-script.test.mjs` → **29 pass / 0 fail**（含 duo 归属、S5–S7 显式 sceneId、enabled=false 零事件）。
- `tsc --noEmit`（HEAD `ed414fa` 快照）→ exit 0；当前工作区失败 4 条均在 `src/petCharacters.ts`（他人未提交改动，非联动文件）。

---

## 3. 缺陷清单（本轮发现，均未改代码）

### D1（P1）`petCount=1` 时「试一下联动」随从只站着：没有台词、没有位移/动作，与使用文档矛盾

- 复现：设置保持 1 只狗（默认）→ 打开实例联动 → 点「试一下联动」。
- 预期：`docs/pet-linkage-usage.md` §3「会临时出现一只随从狗；两只狗各说一句台词，先后差约 0.12 秒，各自头顶冒气泡；小鸡毛会蹦一下…」。
- 实际：代码 `src/petLinkPreview.ts:106-112` `hasCompanion = settings.petCount > 1`，`petCount=1` 时 `labels=[]`，`buildLinkPlan` 只产出主狗自说两句（`:218-222`）；`emitAction` 的 targets 为空（`petLinkBus.ts:456-479`），临时出现的随从窗口收到消息后被 `acceptLinkMessage` 丢弃（`petLinkBus.ts:293-295`，targets 里没有它）→ **随从无动作、无台词**。只有主狗自说两句（A 剧本），演示不出"两只狗接话"。
- 可疑位置：`src/petLinkPreview.ts:106-168`、`src/petLinkBus.ts:293-295`。
- 严重级别：**P1**（默认配置就是 1 只狗；"试一下联动"是用户验收入口，效果与说明不符）。

### D2（P2）随从位移没有缓动：`CompanionPet.tsx` 的 `transition` 被行内注释吞掉

- 位置：`src/CompanionPet.tsx:268`：同一行里 `// …（1200ms）。\n transition: role.speaker === "xiaojimao" \n ? …` ——`//` 注释到行尾，且中间是**字面 `\n` 字符串**，导致 `transition` 不是 style 属性。
- 实际：`transform` 位移瞬时跳变/回跳（`shift` 状态 520ms/1200ms 后清除），没有"260ms 蹦过去 / 1200ms 缓慢回靠"的过渡；与 `docs/pet-linkage-usage.md` §4「回位约 1.2 秒」的观感不符。
- 预期：`transition: transform 260ms …`（小鸡毛）/ `1200ms …`（小白）真正生效；或改用 CSS 类。
- 严重级别：P2（视觉降级，不影响功能/台词）。

### D3（P2）双随从 + 主狗非 duo 时，两只随从角色/台词相同，违反 V7

- 复现：`petCount=3`（companion-1/2 两只），主狗形象为小白或小鸡毛，触发一次联动。
- 预期：`docs/pet-duo-interaction-script.md` V7「不会两只随从都说同一句」。
- 实际：`resolveCompanionRole`（`src/petLinkScript.ts:118-125`）只按窗口奇偶并"与主狗重复就交换"，**不检查两只随从彼此**：main=xiaobai 时 comp1→xiaojimao、comp2→xiaojimao（两句都是 active）；main=xiaojimao 时两只都→xiaobai（同句 shy）。`buildLinkPlan` 直接下发同句台词。
- 实测：`work/qa-link-analysis.mjs` 输出 `companionSameLine=true`（两种主狗形象都复现）；单测只覆盖 `mainCharacter="duo"` 的双随从情形。
- 可疑位置：`src/petLinkScript.ts:118-125`、`:182-217`。
- 严重级别：P2（配置 3–5 只狗时才出现；台词重复显眼）。

### D4（P2）"最近 5 条不重复"与 3 组/场景矛盾：实测 27/30 次仍重复

- 需求：V2「同一对台词在最近 5 条内不重复」+ 文档「最近说过的那几组不会马上重复」。
- 实际：每个场景只有 3 组（`i18n` zh/en 一致），去重窗口 `PET_LINK_NO_REPEAT_WINDOW=5`（`src/petLinkScript.ts:33`）。当 3 组都用过，`pickPairIndex` 的 `fresh` 为空，回退到全集随机（`:53-68`）→ 必然很快复读。脚本模拟 30 次：**27 次落回最近 5 条窗口内**。
- 建议：台词库每场景 ≥6 组，或把窗口改为 3（并同步改验收口径/文档）。
- 严重级别：P2（内容重复，与验收判据直接冲突）。

### D5（P2，代码风险）S5 久坐依赖 `proactiveStreakRef`，而该值可能陈旧/为 0

- 触发逻辑：`App.tsx:9332-9373` 每 60s 检查 `streakMinutes = (now - proactiveStreakRef.current.since)/60000`；`proactiveStreakRef.since` 初值为 `0`（`App.tsx:7103`）。
- 该 ref 只在主动聊天 tick 中更新（`App.tsx:7187-7189`），且 tick 在**静默时段 / 达到每小时上限 / level≤0** 时**提前 return**（`:7162-7165`），不会刷新 `since`。
- 后果：如果在静默时段/关闭主动时启动应用，`since` 可能长时间为 0 或陈旧 → `streakMinutes` 巨大 → 第一个 60s 检查就可能触发「久坐提醒」；反之若 tick 正常刷新则依赖主动聊天是否开启。
- 建议：久坐用独立的"活动 streak"（在 `get_active_activity` 轮询里直接更新，不经过主动聊天的早退分支），并给 `since` 合理初值。
- 严重级别：P2（可能误触发/漏触发，需实机 40min 验证）。

### D6（P3）「不改 localStorage」不严格成立：预览会写台词去重历史

- `petLinkPreview.ts:148` 调 `savePetLinkHistory(window.localStorage, rememberPairHash(...))` → 写 `maltese-pet-link-history`。
- 用户设置键（`focusd-island-settings`）确实未改，但"不改 localStorage"的宣传语（`i18n petLink.previewHint`、usage doc）建议改成"不改你的小狗数量 / Bongo 设置（仅记录台词去重历史）"。

### D7（P3）随从气泡没有可访问名，台词读屏/自动化取不到

- 实测 UIA：随从气泡元素 `class="companion-pet__bubble"` 的 `Name` 为空（`rect=128,1262,104,24`）；文本在子节点里但未聚合。
- 建议：给气泡加 `aria-label={bubble}` 或把文本放到可访问节点；也方便以后做自动化验收。

### 观察（不编号）

- `fireDuoScene` 里 `console.debug("[pet-link] …")` 没有 `import.meta.env.DEV` 门禁（`App.tsx:9209-9211`）→ 生产每次联动打一条日志（设计文档要求生产静默）。
- 新增了 60s 检查 interval（设计约束是"不新增高频定时器"，60s 可接受，但 S5/S6 的判定精度受其限制）。
- 顶部设置页的「实例联动」开关在岛内设置页**无条件显示**（`App.tsx:2820-2824`），独立设置窗口则只在 `petCount>1 || bongoEnabled` 时显示（`SettingsWindow.tsx:413-420`）——两处不一致（非本轮引入）。

---

## 3.1 缺陷处置结果（研发回填 · 2026-11-17，基于 `2ceb0f6` 之后的工作区）

全部 7 条**已在本地修完并带单测**（未 push、未改版本号 2.0.2）；回归单测 `tests/pet-link-fixes.test.mjs`（15 条全绿），
全量 `node --test tests/*.test.mjs` = **149 pass / 0 fail**，`tsc --noEmit` exit 0，`cargo check` 见 §3.2。

| # | 级别 | 处置 | 证据（文件:行 + 关键代码） |
| --- | --- | --- | --- |
| D1 | P1 | **已修**：预览恒按「有随从」造剧本，临时随从必说话 + 主狗说另一句 | `src/petLinkPreviewPlan.ts:16` `PET_LINK_PREVIEW_LABELS = ["companion-1"]`；`:18-33` `buildPreviewPlan()` 恒传该 label（`force: true`）；`src/petLinkPreview.ts:110` `const plan = buildPreviewPlan({ bank, mainCharacter, recent })`、`:126` `labels: [...PET_LINK_PREVIEW_LABELS]`（原来的 `hasCompanion = settings.petCount > 1` 分支已删） |
| D2 | P2 | **已修**：`transition` 是真实 style 属性，小鸡毛 260ms / 小白 1200ms | `src/petLinkCompanionStyle.ts:19` `companionShiftTransition()`；`src/CompanionPet.tsx:295` `` transition: `${companionShiftTransition(eventSpeaker)}, scale 110ms ease` ``（不再有 `\n transition:` 被 `//` 吞掉）；`src/DesktopExtras.css` 被摸扁改 `scale:`，不与 transform 过渡打架 |
| D3 | P2 | **已修**：两只随从彼此不同角色/台词（主狗非 duo 时） | `src/petLinkScript.ts:128` `resolveCompanionRoles(labels, mainCharacter)`（先偏好后互斥）；`:210` `buildLinkPlan` 改用它；`CompanionPet` 以消息里的 `speaker` 为准（`src/CompanionPet.tsx:178` `setEventSpeaker(speaker)`） |
| D4 | P2 | **已修（方案 ①）**：每场景扩到 6 组、zh/en 各 42 组，去重窗口仍 5 | `src/i18n/locales/zh-CN.ts` / `en.ts` 的 `petLink.scenes`（7 场景 × 6 组）；常量 `src/petLinkScript.ts:35` `PET_LINK_MIN_PAIRS_PER_SCENE = 窗口 + 1`；单测模拟 30 次抽取窗口内重复 **0 次**（修复前 27/30） |
| D5 | P2 | **已修**：S5 久坐用独立活动 streak，与主动聊天解耦；`since=0` 不再误触发 | `src/petLinkSedentary.ts:26/36/51/73`（`createSedentaryStreak` / `noteSedentaryActivity` / `sedentaryStreakMinutes` / `shouldFireStandup`）；`src/App.tsx:9342` `duoStreakRef`、`:9376` 喂 60s 检查自采的 `get_active_activity`、`:9378` 判定 |
| D6 | P3 | **已修（文案）**：收窄为「不改设置，仅记一条台词去重历史」 | i18n `petLink.previewHint`（zh `不改你的设置（只在本地记一条台词去重历史）` / en `settings stay unchanged (only a local line-dedupe entry is recorded)`）；`src/petLinkPreview.ts:5` 头注释同步；`src/SettingsWindow.tsx` 同段提示；`docs/pet-linkage-usage.md` §3 |
| D7 | P3 | **已修**：随从气泡带 `aria-label`（`台词：<文本>`），UIA/读屏可读 | `src/CompanionPet.tsx:276` `aria-label={t.petLink.bubbleAria(bubble)}`；i18n `bubbleAria`（zh `台词：${line}` / en `Line: ${line}`，`src/i18n/locales/zh-CN.ts:671`） |

> 「观察（不编号）」三条未在本轮改动范围：dev 日志缺 `import.meta.env.DEV` 门禁、60s 检查粒度、
> 设置页两处「实例联动」显示条件不一致——留作下一轮。

## 4. 交付建议

**不建议在本轮"全部验证通过"的口径下交付**；可以带缺陷进下一版，但需要先修/明确接受：

1. **必修（影响用户第一眼）**：D1（默认 1 只狗时预览演示不成立，直接打脸"试一下联动"卖点）、D2（位移无缓动，观感像瞬移）。
2. **建议本版修**：D3（多狗时两只随从同句）、D4（台词复读；可先扩台词库每组到 6 组）。
3. **可下一版**：D5（S5 依赖主动聊天 streak，先给 `since` 初值 + 独立 streak）、D6/D7（文案/可访问性）。
4. **必须人工补验后再宣称"验收完成"**：V1 的 120ms/位移像素级、V2 连摸 5 次、V4 关开关、V5 solo/Bongo、V6 静默态、V8 10 分钟、rAF <25ms（步骤见 §5）。录像/录屏证据请按 `docs/pet-duo-interaction-script.md` §6 的 V1–V8 一项一条存。

---

## 5. 人工补验步骤（可直接照做）

### 5.1 V1/V3 双窗口观感 + 120ms + 气泡可见性（约 30 秒）

1. 设置 → 桌宠形态 → 打开「实例联动」，把「小狗数量」调到 **2**；
2. 回到桌面，按 `Win+G` 开录屏（30fps）或手机录屏，对准两只狗；
3. 摸主狗头一次；观察：小鸡毛先动（蹦/放大），小白约 0.12s 后动（退半步再回），**两只狗各自头顶冒气泡**；
4. 录屏逐帧检查：两个气泡出现时间差 ≥120ms；气泡完整在各自窗口内、停留 1.6–2.2s；
5. 若只想看演示：设置里点「试一下联动」（注意：**1 只狗时随从不会说话，见 D1**，需先把数量调到 ≥2）。

### 5.2 V2 连摸 5 次（约 2 分钟）

`petCount=2`、联动开；以 **≥1.5s** 间隔摸主狗头 5 次，录屏统计「成对台词出现次数」≥4 次；同时记录最近 5 对台词是否重复（当前 3 组库大概率复读，见 D4）。

### 5.3 rAF 间隔 <25ms（DevTools）

在 `pnpm tauri dev` 或开 DevTools 的构建里，主窗口 Console 执行：

```js
(async () => {
  const gaps = [];
  let last = performance.now();
  const end = last + 2000;
  await new Promise((resolve) => {
    const loop = (t) => {
      gaps.push(t - last); last = t;
      if (t < end) requestAnimationFrame(loop); else resolve();
    };
    requestAnimationFrame(loop);
  });
  const sorted = gaps.slice(1).sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log("frames", sorted.length, "avg", avg.toFixed(2), "p95", sorted[Math.floor(sorted.length * 0.95)].toFixed(2), "max", sorted[sorted.length - 1].toFixed(2));
})();
```

联动进行时（摸头/试一下联动）跑 2 秒，要求 **max < 25ms**（≈40fps 下限）；同时观察是否有 >50ms 长帧。

### 5.4 V5 / V6 / V8

- V5（只有主狗）：`petCount=1`、Bongo 关 → 点「试一下联动」，应出现 A 剧本两句（主狗自说）；有 Bongo 时追加敲击 + 两句。
- V6（静默态）：缩边/面板展开/隐藏到托盘时摸主狗 → 不应出现任何联动台词；已出现的 1s 内消失。
- V8：`petCount=2`、联动开，挂 10 分钟，记录台词重复次数与 CPU/内存曲线（任务管理器）。

---

## 6. 环境说明与证据文件

- 测试期间研发在同一工作区持续提交/重启：`HEAD` 由 `c992e9d` → `ed414fa`（15:0x，补 duo/S5–S7/日志/使用文档）→ `e493cb6`；应用 15:06:05 重新构建、15:06/15:07 两次重启。**本报告的实测证据来自 15:06 之后的构建**，代码行号以 `ed414fa`/`e493cb6` 为准。
- 为测「试一下联动」曾**临时**打开实例联动、把小狗数量调到 2；测完已恢复为 `petLinkage=false`、`petCount=1`，随从窗口已隐藏（最后一次 2→1 强制同步后确认 `COMPANION=hidden`，见 `work/qa-link-cleanup` 输出）。用户设置键未被永久改动；唯一副作用是台词去重历史 `maltese-pet-link-history` 可能新增 1–2 条 hash。
- 证据文件（`work/`，gitignore）：
  - `work/qa-link-v1.log` / `qa-link-v1-main.png` / `qa-link-v1-companion.png`：试一下联动时序与截图；
  - `work/qa-link-preview2.log`：预览触发、主狗窗口 530ms→3539ms 复原、主狗台词文本；
  - `work/qa-link-text.log`：随从 UIA 树（气泡 name 为空）；
  - `work/qa-link-analysis.mjs`：去重/双随从/场景/台词库分析脚本与输出；
  - `work/qa-link-smoke*.log`：回归冒烟（7 tabs、待办/聊天/视频面板）；
  - `work/qa-link-prep.log`：随从窗口 UIA（200×180 companion-pet）。
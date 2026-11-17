import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPetGifDeletion,
  cancelPetGifRemoval,
  finishPetGifRemoval,
  PET_GIF_REMOVAL_IDLE,
  PET_GIF_TRASH_LIMIT,
  pushPetGifTrashEntry,
  removePetGifTrashEntry,
  requestPetGifRemoval,
  restorePetGifItemIntoList,
  sortPetGifTrash,
} from "../src/utils/petGifRemoval.ts";

const gif = (id, extra = {}) => ({ id, name: `${id}.gif`, src: `/assets/pets/${id}.gif`, ...extra });

function trashEntry(id, deletedAt) {
  return {
    id: `trash-${id}`,
    character: "xiaojimao",
    state: "idle",
    index: 0,
    item: gif(id, { custom: true, path: `C:/data/pet-gifs/idle/${id}.gif` }),
    deletedAt,
    trashPath: `C:/data/pet-gifs-trash/${deletedAt}-${id}.gif`,
  };
}

// ---------------------------------------------------------------------------
// 确认流程：未确认绝不能删
// ---------------------------------------------------------------------------

test("右键只是进入确认态，不会删除", () => {
  const item = gif("a");
  const state = requestPetGifRemoval(PET_GIF_REMOVAL_IDLE, item);
  assert.equal(state.status, "confirming");
  assert.equal(state.item.id, "a");
  // 还没确认时调用「开始删除」拿不到任何东西
  const deletion = beginPetGifDeletion(PET_GIF_REMOVAL_IDLE);
  assert.equal(deletion.item, null);
  assert.equal(deletion.state.status, "idle");
});

test("确认后才拿到要删除的项，且不能重复删除", () => {
  const pending = requestPetGifRemoval(PET_GIF_REMOVAL_IDLE, gif("b"));
  const deletion = beginPetGifDeletion(pending);
  assert.equal(deletion.item.id, "b");
  assert.equal(deletion.state.status, "deleting");
  // 删除中再触发一次（例如双击）不会删第二张
  const again = beginPetGifDeletion(deletion.state);
  assert.equal(again.item, null);
  assert.equal(again.state.status, "deleting");
});

test("取消（Esc/点取消）后回到空闲，仍然什么都不删", () => {
  const pending = requestPetGifRemoval(PET_GIF_REMOVAL_IDLE, gif("c"));
  const cancelled = cancelPetGifRemoval(pending);
  assert.equal(cancelled, PET_GIF_REMOVAL_IDLE);
  assert.equal(beginPetGifDeletion(cancelled).item, null);
});

test("确认框打开期间的新请求被忽略（不会换掉正在确认的项）", () => {
  const pending = requestPetGifRemoval(PET_GIF_REMOVAL_IDLE, gif("d"));
  const spam = requestPetGifRemoval(pending, gif("e"));
  assert.equal(spam, pending);
  assert.equal(spam.item.id, "d");
});

test("删除写完后收掉确认框；非删除态调用 finish 无副作用", () => {
  const confirmed = beginPetGifDeletion(
    requestPetGifRemoval(PET_GIF_REMOVAL_IDLE, gif("f")),
  ).state;
  assert.equal(finishPetGifRemoval(confirmed), PET_GIF_REMOVAL_IDLE);
  assert.equal(finishPetGifRemoval(PET_GIF_REMOVAL_IDLE), PET_GIF_REMOVAL_IDLE);
  assert.deepEqual(cancelPetGifRemoval(confirmed), confirmed);
});

// ---------------------------------------------------------------------------
// 回收站：上限 10 条、最新的在最前面、满了挤掉最旧的一条
// ---------------------------------------------------------------------------

test("回收站按最新在前插入", () => {
  const { entries, evicted } = pushPetGifTrashEntry([], trashEntry("a", 1));
  assert.equal(entries.length, 1);
  assert.equal(evicted, null);
  const second = pushPetGifTrashEntry(entries, trashEntry("b", 2));
  assert.deepEqual(
    second.entries.map((entry) => entry.item.id),
    ["b", "a"],
  );
});

test("回收站超过上限时挤掉最旧的一条", () => {
  let entries = [];
  for (let index = 0; index < PET_GIF_TRASH_LIMIT; index += 1) {
    entries = pushPetGifTrashEntry(entries, trashEntry(`old-${index}`, index + 1)).entries;
  }
  assert.equal(entries.length, PET_GIF_TRASH_LIMIT);
  const { entries: capped, evicted } = pushPetGifTrashEntry(
    entries,
    trashEntry("newest", 100),
  );
  assert.equal(capped.length, PET_GIF_TRASH_LIMIT);
  assert.equal(capped[0].item.id, "newest");
  assert.equal(evicted.item.id, "old-0", "被挤出去的应该是最旧的一条");
});

test("同一 id 重复插入会覆盖而不是占两条", () => {
  const first = pushPetGifTrashEntry([], trashEntry("a", 1));
  const again = pushPetGifTrashEntry(first.entries, trashEntry("a", 5));
  assert.equal(again.entries.length, 1);
  assert.equal(again.entries[0].deletedAt, 5);
});

test("恢复后从回收站移除，排序稳定", () => {
  const entries = [trashEntry("a", 1), trashEntry("b", 3), trashEntry("c", 2)];
  const sorted = sortPetGifTrash(entries);
  assert.deepEqual(
    sorted.map((entry) => entry.item.id),
    ["b", "c", "a"],
  );
  const restored = removePetGifTrashEntry(sorted, "trash-c");
  assert.deepEqual(
    restored.map((entry) => entry.item.id),
    ["b", "a"],
  );
});

// ---------------------------------------------------------------------------
// 顺序恢复：插回原下标
// ---------------------------------------------------------------------------

test("恢复时插回原位置，其余项顺序不变", () => {
  const list = [gif("a"), gif("b"), gif("d")];
  const restored = restorePetGifItemIntoList(list, gif("c"), 2);
  assert.deepEqual(
    restored.map((item) => item.id),
    ["a", "b", "c", "d"],
  );
  // 原数组不被修改
  assert.deepEqual(
    list.map((item) => item.id),
    ["a", "b", "d"],
  );
});

test("下标越界时夹到末尾/开头，不会丢项", () => {
  const list = [gif("a"), gif("b")];
  assert.deepEqual(
    restorePetGifItemIntoList(list, gif("c"), 99).map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    restorePetGifItemIntoList(list, gif("z"), -4).map((item) => item.id),
    ["z", "a", "b"],
  );
  assert.deepEqual(
    restorePetGifItemIntoList([], gif("only"), 3).map((item) => item.id),
    ["only"],
  );
});

test("已经在列表里的项不会重复恢复成两张", () => {
  const list = [gif("a"), gif("b")];
  const restored = restorePetGifItemIntoList(list, gif("a"), 0);
  assert.deepEqual(
    restored.map((item) => item.id),
    ["a", "b"],
  );
});

console.log("pet gif removal tests passed");
// 由 scripts/build-pet-manifest.mjs 自动生成，请勿手改。
// 结构：分组 -> 动作 -> GIF 路径（路径已做 URL 编码）。
// 各组素材位于同目录的 generated.<group>.ts，避免单文件持续膨胀。
import { PET_CHARACTER_ASSETS_XIAOBAI } from "./petCharacterAssets.generated.xiaobai";
import { PET_CHARACTER_ASSETS_XIAOJIMAO } from "./petCharacterAssets.generated.xiaojimao";
import { PET_CHARACTER_ASSETS_SHARED } from "./petCharacterAssets.generated.shared";
import { PET_CHARACTER_ASSETS_STICKERS } from "./petCharacterAssets.generated.stickers";
import { PET_CHARACTER_ASSETS_LEGACY } from "./petCharacterAssets.generated.legacy";

export const PET_CHARACTER_ASSETS: Record<string, Record<string, string[]>> = {
  "xiaobai": PET_CHARACTER_ASSETS_XIAOBAI,
  "xiaojimao": PET_CHARACTER_ASSETS_XIAOJIMAO,
  "shared": PET_CHARACTER_ASSETS_SHARED,
  "stickers": PET_CHARACTER_ASSETS_STICKERS,
  "legacy": PET_CHARACTER_ASSETS_LEGACY,
};

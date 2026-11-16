// 聊天里用的形象头像：从角色素材里各截一张正面帧，统一 160×160 透明 PNG，
// 存放在 assets/pets/avatars/（和 GIF 一起被打进安装包资源目录）。
import { petAssetUrl } from "./petAssetBase";
import type { PetCharacterId } from "./petCharacters";

export const PET_AVATAR_FILES: Record<PetCharacterId, string> = {
  xiaobai: "/assets/pets/avatars/xiaobai.png",
  xiaojimao: "/assets/pets/avatars/xiaojimao.png",
  duo: "/assets/pets/avatars/duo.png",
};

export function petAvatarUrl(character: PetCharacterId): string {
  return petAssetUrl(PET_AVATAR_FILES[character] ?? PET_AVATAR_FILES.xiaobai);
}

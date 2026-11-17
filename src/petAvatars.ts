// 聊天里用的形象头像：三个 160×160 透明 PNG，直接打进前端产物。
//
// 以前它们和 GIF 素材一起外置，靠 petAssetBase 在运行时解析资源目录。
// 但聊天窗口里只要资源目录解析慢一步或没命中，头像就是裂图；
// 这三张图总共不到 50 KB，没必要承担外置素材的解析风险，所以改为 import 打包。
import xiaobaiAvatar from "./assets/pet-avatars/xiaobai.png";
import xiaojimaoAvatar from "./assets/pet-avatars/xiaojimao.png";
import duoAvatar from "./assets/pet-avatars/duo.png";
import type { PetCharacterId } from "./petCharacters";

export const PET_AVATAR_FILES: Record<PetCharacterId, string> = {
  xiaobai: xiaobaiAvatar,
  xiaojimao: xiaojimaoAvatar,
  duo: duoAvatar,
};

export function petAvatarUrl(character: PetCharacterId): string {
  return PET_AVATAR_FILES[character] ?? xiaobaiAvatar;
}

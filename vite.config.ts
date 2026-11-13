import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 桌宠素材已外置到仓库根的 assets/pets（安装后位于 <安装目录>/resources/assets/pets）。
// 生产环境由 Rust 命令 get_pet_asset_base + convertFileSrc 读取；开发环境这里补一个
// 只读静态服务，让 `pnpm dev` 仍然能加载 /assets/pets/...，不必把 43 MB 素材再复制回 public。
const PET_ASSETS_ROOT = resolve("assets/pets");
const MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

function petAssetsDevServer() {
  return {
    name: "maltese-pet-assets-dev",
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use((req: { url?: string }, res: any, next: () => void) => {
        const url = req.url ?? "";
        if (!url.startsWith("/assets/pets/")) return next();
        const rawPath = decodeURIComponent(url.split("?")[0].slice("/assets/pets/".length));
        const filePath = normalize(join(PET_ASSETS_ROOT, rawPath));
        // 目录穿越保护：解析后必须仍在素材根目录内。
        if (!filePath.startsWith(PET_ASSETS_ROOT + sep)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("Content-Type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), petAssetsDevServer()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
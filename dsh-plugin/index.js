import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const EXE_NAME = "maltese-assistant.exe";

/**
 * Find a usable Maltese executable without guessing a single install layout.
 * The explicit config/env values win; the remaining candidates cover a local
 * checkout, the current workspace, and the usual Windows install folders.
 */
function findExecutable(config) {
  const candidates = [];
  const configured = typeof config?.executablePath === "string" ? config.executablePath.trim() : "";
  if (configured) {
    candidates.push(resolve(PLUGIN_DIR, configured));
  }

  const fromEnv = process.env.MALTESE_EXE?.trim();
  if (fromEnv) {
    candidates.push(resolve(fromEnv));
  }

  const roots = new Set([PLUGIN_DIR, dirname(PLUGIN_DIR), process.cwd()]);
  for (const root of roots) {
    const releaseDir = join(root, "release");
    if (!existsSync(releaseDir)) {
      continue;
    }
    try {
      const versions = readdirSync(releaseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const directory = join(releaseDir, entry.name);
          return {
            executable: join(directory, EXE_NAME),
            modifiedAt: statSync(directory).mtimeMs,
          };
        })
        .filter((entry) => existsSync(entry.executable))
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      candidates.push(...versions.map((entry) => entry.executable));
    } catch {
      // A missing/locked release directory must not disable the plugin.
    }
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      join(localAppData, "Programs", "Maltese", EXE_NAME),
      join(localAppData, "Maltese", EXE_NAME),
    );
  }
  for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (programFiles) {
      candidates.push(join(programFiles, "Maltese", EXE_NAME));
    }
  }
  candidates.push(join(homedir(), "Maltese", EXE_NAME));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isRunning(executable) {
  const imageName = executable ? basename(executable) : EXE_NAME;
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 5000 },
    );
    return stdout.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

function launch(executable) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [], {
      cwd: dirname(executable),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function openPet(config) {
  const executable = findExecutable(config);
  if (!executable) {
    return {
      ok: false,
      running: false,
      executable: "",
      message:
        "没有找到 maltese-assistant.exe。请先安装 Maltese，或设置环境变量 MALTESE_EXE / 插件配置 executablePath。",
    };
  }
  if (await isRunning(executable)) {
    return {
      ok: true,
      running: true,
      executable,
      message: `Maltese 已经在运行：${executable}`,
    };
  }
  try {
    await launch(executable);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
    return {
      ok: true,
      running: await isRunning(executable),
      executable,
      message: `已启动 Maltese：${executable}`,
    };
  } catch (error) {
    return {
      ok: false,
      running: false,
      executable,
      message: `启动 Maltese 失败：${String(error)}`,
    };
  }
}

async function statusPet(config) {
  const executable = findExecutable(config);
  if (!executable) {
    return {
      ok: false,
      running: false,
      executable: "",
      message:
        "没有找到 maltese-assistant.exe。请先安装 Maltese，或设置环境变量 MALTESE_EXE / 插件配置 executablePath。",
    };
  }
  const running = await isRunning(executable);
  return {
    ok: true,
    running,
    executable,
    message: running ? `Maltese 正在运行：${executable}` : `Maltese 未运行：${executable}`,
  };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    running: { type: "boolean" },
    executable: { type: "string" },
    message: { type: "string" },
  },
  required: ["ok", "running", "message"],
  additionalProperties: false,
};

export const name = "maltese-dsh";
export const inject = ["tools"];

export function apply(ctx, config = {}) {
  ctx.effect(() =>
    ctx.tools.register({
      name: "maltese_pet",
      description:
        "启动或检查 Maltese 线条小狗桌面宠物。桌宠是独立原生窗口；本工具只负责启动和状态，不会截屏或读取桌面内容。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["open", "status"],
            description: "open 启动桌宠（已在运行则直接返回）；status 只检查是否在运行。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          return [{ type: "text", text: String(value?.message ?? "Maltese 操作完成") }];
        },
      },
      async execute(args) {
        const action = args && typeof args === "object" && args.action === "status" ? "status" : "open";
        return action === "status" ? statusPet(config) : openPet(config);
      },
    }),
  );

  if (config?.autoLaunch !== false) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void openPet(config).then((result) => {
          if (!result.ok) {
            console.warn(`[maltese-dsh] ${result.message}`);
          }
        });
      }, 1200);
      return () => clearTimeout(timer);
    });
  }
}
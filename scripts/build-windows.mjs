// Builds the Windows release artifacts for Maltese:
//   1. release exe   -> release/Maltese-assistant.exe
//   2. NSIS installer -> src-tauri/target/release/bundle/nsis/
//
// Usage:
//   node scripts/build-windows.mjs [--dry-run]
//
// --dry-run prints every command instead of executing it (the exe copy step
// still runs when the source exe already exists, so the copy logic stays
// testable).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const EXE_SOURCE = join(ROOT, "src-tauri", "target", "release", "maltese-assistant.exe");
const RELEASE_DIR = join(ROOT, "release");
const EXE_TARGET = join(RELEASE_DIR, "Maltese-assistant.exe");
const NSIS_DIR = join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");

function fail(message) {
  console.error(`\n[ERROR] ${message}`);
  process.exit(1);
}

// pmInvoke is "pnpm" | "corepack pnpm" | "npm". The binary and any
// prefix arguments are split so spawnSync receives an argv array.
function run(pmInvoke, args) {
  const display = `${pmInvoke} ${args.join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] ${display}`);
    return true;
  }
  const [binary, ...prefixArgs] = pmInvoke.split(" ");
  const allArgs = [...prefixArgs, ...args];
  console.log(`\n$ ${display}`);
  const result = spawnSync(binary, allArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) fail(`${binary} could not run: ${result.error.message}`);
  return result.status === 0;
}

function probeOk(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "pipe",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function detectPackageManager() {
  // Prefer pnpm (direct install), then pnpm via corepack, then npm.
  for (const [bin, ...testArgs] of [
    ["pnpm"],
    ["corepack", "pnpm"],
    ["npm"],
  ]) {
    if (probeOk(bin, [...testArgs, "--version"])) {
      if (bin === "corepack") return "corepack pnpm";
      return bin;
    }
  }
  return null;
}

console.log("=== Maltese Desktop Assistant - Windows build ===");
if (dryRun) console.log("(dry run: commands are printed, not executed)");

const pmInvoke = detectPackageManager();
if (!pmInvoke) {
  fail("pnpm / corepack pnpm / npm not found on PATH. Install Node.js (with npm) first.");
}

const usingNpm = pmInvoke.startsWith("npm");
const pnpmLock = join(ROOT, "pnpm-lock.yaml");
if (usingNpm && existsSync(pnpmLock)) {
  console.log("[cleanup] pnpm node_modules are not usable by npm — removing before npm install...");
  rmSync(join(ROOT, "node_modules"), { recursive: true, force: true });
}

console.log(`Package manager: ${pmInvoke}`);

console.log("\n[1/3] Installing dependencies...");
if (!run(pmInvoke, ["install"])) fail("Dependency installation failed.");

console.log("\n[2/3] Building release exe...");
if (!run(pmInvoke, ["run", "build:exe"])) fail("Exe build failed.");
if (!dryRun && !existsSync(EXE_SOURCE)) fail(`Expected exe not found at ${EXE_SOURCE}`);
if (!dryRun || existsSync(EXE_SOURCE)) {
  mkdirSync(RELEASE_DIR, { recursive: true });
  copyFileSync(EXE_SOURCE, EXE_TARGET);
  console.log("exe ready: release/Maltese-assistant.exe");
}

console.log("\n[3/3] Building NSIS installer...");
if (!run(pmInvoke, ["run", "build:installer"])) fail("Installer build failed.");

console.log("\n=== Done ===");
console.log("exe      : release/Maltese-assistant.exe");
if (existsSync(NSIS_DIR)) {
  const installers = readdirSync(NSIS_DIR).filter(
    (name) => name.endsWith("-setup.exe") || name.endsWith("_setup.exe"),
  );
  if (installers.length) console.log(`installer: src-tauri/target/release/bundle/nsis/${installers[0]}`);
  else console.log("installer: src-tauri/target/release/bundle/nsis/");
} else {
  console.log("installer: src-tauri/target/release/bundle/nsis/");
}
if (!dryRun && process.platform === "win32" && existsSync(NSIS_DIR)) {
  spawnSync("explorer", [NSIS_DIR], { windowsHide: false });
}
// Builds the updater manifest that the app downloads from
// https://github.com/maolouis/Maltese/releases/latest/download/latest.json
//
// Usage: node scripts/make-latest-json.mjs [--notes-file docs/releases/vX.Y.Z.md]
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "maolouis/Maltese";
const CONFIG = "src-tauri/tauri.conf.json";
const BUNDLE_DIR = "src-tauri/target/release/bundle/nsis";
const MSI_DIR = "src-tauri/target/release/bundle/msi";

const args = process.argv.slice(2);
const notesFlag = args.indexOf("--notes-file");
const baseFlag = args.indexOf("--base-url");
const baseUrl = baseFlag >= 0 ? args[baseFlag + 1]?.replace(/\/$/, "") : `https://github.com/${REPO}/releases/download/v${readVersion()}`;
if (!baseUrl || !URL.canParse(baseUrl) || new URL(baseUrl).protocol !== "https:") {
  console.error("--base-url requires a valid HTTPS URL.");
  process.exit(1);
}
const notesFile = notesFlag >= 0 ? args[notesFlag + 1] : `docs/releases/v${readVersion()}.md`;

function readVersion() {
  return JSON.parse(readFileSync(CONFIG, "utf8")).version;
}

const version = readVersion();

if (!existsSync(BUNDLE_DIR)) {
  console.error(`Missing ${BUNDLE_DIR}. Run "pnpm tauri build" first.`);
  process.exit(1);
}

const suffix = `_${version}_x64-setup.exe`;
const installer = readdirSync(BUNDLE_DIR).find((name) => name.endsWith(suffix));

if (!installer) {
  console.error(`Missing NSIS installer ending with ${suffix} in ${BUNDLE_DIR}.`);
  process.exit(1);
}

const signaturePath = join(BUNDLE_DIR, `${installer}.sig`);
if (!existsSync(signaturePath)) {
  console.error(`Missing ${signaturePath}. Build with TAURI_SIGNING_PRIVATE_KEY set so updater artifacts are signed.`);
  process.exit(1);
}

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";
// GitHub rewrites non-ASCII release asset names (the Chinese product name became
// "Maltese._..." during upload), so every release uses a stable ASCII asset name.
// Stage a copy under that name; content and signature are unchanged.
const assetBase = `Maltese-${version}-x64`;
const nsisAsset = `${assetBase}-setup.exe`;
const stagedInstaller = join(BUNDLE_DIR, nsisAsset);
const stagedSignature = `${stagedInstaller}.sig`;
copyFileSync(join(BUNDLE_DIR, installer), stagedInstaller);
copyFileSync(signaturePath, stagedSignature);
const nsisTarget = {
  signature: readFileSync(stagedSignature, "utf8").trim(),
  url: `${baseUrl}/${nsisAsset}`,
};

const platforms = {
  "windows-x86_64": nsisTarget,
  "windows-x86_64-nsis": nsisTarget,
};

// MSI 是可选的：只出 NSIS 时 Tauri 在 Windows 上仍然可以正常更新。
const msi = existsSync(MSI_DIR) && readdirSync(MSI_DIR).find((name) => name.endsWith(`_${version}_x64_en-US.msi`));
const msiSignaturePath = msi && join(MSI_DIR, `${msi}.sig`);
if (msi) {
  if (!msiSignaturePath || !existsSync(msiSignaturePath)) {
    console.error(`Missing signed MSI: ${msiSignaturePath}. An MSI present in the bundle must be signed; remove it or sign it before generating latest.json.`);
    process.exit(1);
  }
  const msiAsset = `${assetBase}.msi`;
  const stagedMsi = join(MSI_DIR, msiAsset);
  const stagedMsiSignature = `${stagedMsi}.sig`;
  copyFileSync(join(MSI_DIR, msi), stagedMsi);
  copyFileSync(msiSignaturePath, stagedMsiSignature);
  platforms["windows-x86_64-msi"] = {
    signature: readFileSync(stagedMsiSignature, "utf8").trim(),
    url: `${baseUrl}/${msiAsset}`,
  };
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};

const target = join(BUNDLE_DIR, "latest.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${target}`);
console.log(`Upload these release assets:`);
console.log(`  ${stagedInstaller}`);
console.log(`  ${stagedSignature}`);
console.log(`  ${target}`);

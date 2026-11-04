#!/usr/bin/env node
// 交付自检：确认 release exe 是单文件版本。
//
// WebView2Loader 在 MSVC 目标下由 webview2-com-sys 静态链接进 exe
// （target_env = "msvc" 时链接 WebView2LoaderStatic.lib）。如果误用 GNU
// 工具链或旧构建脚本，exe 的导入表里会出现 WebView2Loader.dll，发布包就
// 必须再带一个 DLL。这里直接读 PE 导入表，不依赖 dumpbin。
//
// 用法：node scripts/verify-single-exe.mjs [exe路径]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORBIDDEN_IMPORTS = new Set(["webview2loader.dll"]);

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end === -1 ? buffer.length : end).toString("ascii");
}

function readImports(buffer) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("不是有效的 PE 文件（缺少 MZ 头）");
  }

  const peOffset = readU32(buffer, 0x3c);
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("不是有效的 PE 文件（缺少 PE 签名）");
  }

  const coffOffset = peOffset + 4;
  const sectionCount = readU16(buffer, coffOffset + 2);
  const optionalSize = readU16(buffer, coffOffset + 16);
  const optionalOffset = coffOffset + 20;
  const magic = readU16(buffer, optionalOffset);
  const dataDirectoryOffset = optionalOffset + (magic === 0x20b ? 112 : 96);
  const importRva = readU32(buffer, dataDirectoryOffset + 8);

  if (!importRva) {
    return [];
  }

  const sectionOffset = optionalOffset + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    sections.push({
      virtualAddress: readU32(buffer, offset + 12),
      virtualSize: readU32(buffer, offset + 8),
      rawSize: readU32(buffer, offset + 16),
      rawOffset: readU32(buffer, offset + 20),
    });
  }

  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.rawOffset + (rva - section.virtualAddress);
      }
    }
    throw new Error(`无法把 RVA 0x${rva.toString(16)} 映射到文件偏移`);
  };

  const imports = [];
  for (let descriptor = rvaToOffset(importRva); ; descriptor += 20) {
    const originalFirstThunk = readU32(buffer, descriptor);
    const nameRva = readU32(buffer, descriptor + 12);
    const firstThunk = readU32(buffer, descriptor + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) {
      break;
    }
    imports.push(readCString(buffer, rvaToOffset(nameRva)));
  }
  return imports;
}

export function verifySingleExe(exePath) {
  const absolute = path.resolve(exePath);
  const buffer = fs.readFileSync(absolute);
  const imports = readImports(buffer);
  const forbidden = imports.filter((name) => FORBIDDEN_IMPORTS.has(name.toLowerCase()));

  if (forbidden.length > 0) {
    throw new Error(
      `exe 仍动态依赖 ${forbidden.join(", ")}；请用 x86_64-pc-windows-msvc 目标重新构建，` +
        "静态 loader 会由 webview2-com-sys 自动链接。",
    );
  }

  const siblingLoader = path.join(path.dirname(absolute), "WebView2Loader.dll");
  if (fs.existsSync(siblingLoader)) {
    throw new Error(`exe 同目录仍存在 ${path.basename(siblingLoader)}，发布包不是单文件。`);
  }

  console.log(
    `[single-exe] ✓ ${path.basename(absolute)} 未导入 WebView2Loader.dll（共 ${imports.length} 个系统 DLL）`,
  );
  return imports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exePath = process.argv[2] ?? "src-tauri/target/release/maltese-assistant.exe";
  try {
    verifySingleExe(exePath);
  } catch (error) {
    console.error(`[single-exe] ✗ ${error.message}`);
    process.exitCode = 1;
  }
}
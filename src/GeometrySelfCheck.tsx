import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { useTranslation } from "./i18n";

type GeometryScenario = {
  op: string;
  before: { x: number; y: number };
  after: { x: number; y: number };
  dx: number;
  dy: number;
  pass: boolean;
};

type GeometrySelftestResult = {
  tolerance: number;
  total: number;
  passed: number;
  scenarios: GeometryScenario[];
};

const cellStyle = { padding: "2px 8px", textAlign: "left" as const, fontSize: 12 };
const headStyle = { ...cellStyle, fontWeight: 600, opacity: 0.75 };

/**
 * 几何自检（设置页「诊断」）：跑 Rust 的 island_geometry_selftest，8 个场景 × pass/dx/dy。
 * 失败项标红，可复制 JSON，方便用户直接贴回来。
 */
export function GeometrySelfCheck() {
  const t = useTranslation();
  const copy = t.geometrySelfCheck;
  const [result, setResult] = useState<GeometrySelftestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sizeReset, setSizeReset] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    setCopied(false);
    try {
      const next = await invoke<GeometrySelftestResult>("island_geometry_selftest");
      setResult(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRunning(false);
    }
  };

  const copyJson = async () => {
    const text = JSON.stringify(result ?? { error }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const resetSize = async () => {
    try {
      await invoke("reset_island_size");
      setSizeReset(true);
    } catch {
      setSizeReset(false);
    }
  };

  const failed = result ? result.total - result.passed : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <strong style={{ fontSize: 14 }}>{copy.title}</strong>
        <button type="button" onClick={() => void run()} disabled={running}>
          {running ? copy.running : copy.run}
        </button>
      </div>
      {result ? (
        <>
          <div style={{ fontSize: 13 }}>
            {copy.summary(result.passed, result.total)}
            {failed > 0 ? ` · ${copy.failed(failed)}` : ""}
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={headStyle}>{copy.scene}</th>
                <th style={headStyle}>{copy.result}</th>
                <th style={headStyle}>{copy.delta}</th>
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((scenario) => (
                <tr
                  key={scenario.op}
                  style={scenario.pass ? undefined : { color: "#d33", fontWeight: 600 }}
                >
                  <td style={cellStyle}>{scenario.op}</td>
                  <td style={cellStyle}>{scenario.pass ? copy.pass : copy.fail}</td>
                  <td style={cellStyle}>
                    {scenario.dx},{scenario.dy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {failed > 0 && <div style={{ fontSize: 12, color: "#d33" }}>{copy.failHint}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void copyJson()}>
              {copied ? copy.copied : copy.copy}
            </button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.75 }}>{copy.empty}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" onClick={() => void resetSize()}>
          {sizeReset ? copy.resetSizeDone : copy.resetSize}
        </button>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{copy.resetSizeHint}</span>
      </div>
      {error && <div style={{ fontSize: 12, color: "#d33" }}>{copy.error(error)}</div>}
    </div>
  );
}
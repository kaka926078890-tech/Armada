import * as vscode from "vscode";

export interface ArmadaConfig { hubUrl: string; token: string; cdpPort: number; autoSubmit: boolean; imagePaste: boolean; }

export function loadConfig(): ArmadaConfig | null {
  const cfg = vscode.workspace.getConfiguration("armada");
  const hubUrl = cfg.get<string>("hubUrl") || process.env.ARMADA_HUB_URL || "";
  const token = cfg.get<string>("token") || process.env.ARMADA_HUB_TOKEN || "";
  if (!hubUrl || !token) return null;
  return {
    hubUrl: hubUrl.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    token,
    cdpPort: cfg.get<number>("cdpPort") || 9222,
    autoSubmit: cfg.get<boolean>("autoSubmit") ?? true,
    imagePaste: cfg.get<boolean>("imagePaste") ?? true,
  };
}

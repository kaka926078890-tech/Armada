import * as vscode from "vscode";

export interface ArmadaConfig { hubUrl: string; token: string; }

export function loadConfig(): ArmadaConfig | null {
  const cfg = vscode.workspace.getConfiguration("armada");
  const hubUrl = cfg.get<string>("hubUrl") || process.env.ARMADA_HUB_URL || "";
  const token = cfg.get<string>("token") || process.env.ARMADA_HUB_TOKEN || "";
  if (!hubUrl || !token) return null;
  return { hubUrl: hubUrl.replace(/^https?:\/\//, "").replace(/\/+$/, ""), token };
}

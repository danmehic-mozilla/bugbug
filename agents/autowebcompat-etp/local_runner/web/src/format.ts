import type { EtpLevel, RunInfo } from "./api";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function formatTime(seconds: number | null | undefined): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "";
}

export function formatDuration(run: RunInfo, now: number): string {
  if (!run.started) return "";
  const total = Math.round((run.finished ?? now / 1000) - run.started);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export function formatCost(
  cost: number | null | undefined,
  digits = 2
): string {
  return cost == null ? "—" : `$${cost.toFixed(digits)}`;
}

export function brokenLabel(value: boolean | null): string {
  if (value === true) return "broken";
  if (value === false) return "works";
  return "not tested";
}

export function isActive(run: RunInfo): boolean {
  return run.active && run.finished == null;
}

const ETP_LABELS: Record<EtpLevel, string> = {
  off: "ETP Off",
  standard: "ETP Standard",
  strict: "ETP Strict",
};

export type ConfigParts = {
  etp?: EtpLevel | null;
  easylist?: boolean;
  easyprivacy?: boolean;
  private?: boolean | null;
};

/**
 * One line per part, e.g. ["ETP Standard", "+ EasyList", "+ Private Browsing
 * Mode"]; empty when the run recorded no target.
 */
export function configLines(config: ConfigParts): string[] {
  if (!config.etp) return [];
  return [
    ETP_LABELS[config.etp],
    ...(config.easylist ? ["+ EasyList"] : []),
    ...(config.easyprivacy ? ["+ EasyPrivacy"] : []),
    ...(config.private ? ["+ Private Browsing Mode"] : []),
  ];
}

/** 202611171744 -> 2026-11-17 17:44; anything else unchanged. */
export function formatListVersion(version: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : version;
}

/**
 * The configuration the agent compares a target against, where the site should
 * work: ETP Standard for a Strict target, else ETP Off without lists, in the
 * same kind of window.
 */
export function baselineConfig(target: ConfigParts): ConfigParts {
  if (!target.etp) return {};
  return {
    etp: target.etp === "strict" ? "standard" : "off",
    private: target.private,
  };
}

/** The same on one line, e.g. "ETP Standard + EasyList + Private Browsing Mode". */
export function configLabel(config: ConfigParts): string {
  return configLines(config).join(" ");
}

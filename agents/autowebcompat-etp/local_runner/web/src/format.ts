import type { EtpLevel, Mode, RunInfo } from "./api";

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
  mode?: Mode | null;
  exceptions_baseline?: boolean | null;
  exceptions_convenience?: boolean | null;
};

/**
 * Whether the baseline and convenience ETP exceptions apply by default, as in
 * Firefox's ContentBlockingPrefs: Strict leaves out convenience.
 */
export function defaultExceptions(etp: EtpLevel): [boolean, boolean] {
  return [true, etp !== "strict"];
}

/**
 * Whether each ETP exception category applies, like the agent's
 * effective_exceptions: null keeps the level's default, `retest` turns
 * baseline off, and convenience needs baseline.
 */
export function appliedExceptions(config: ConfigParts): [boolean, boolean] {
  const [baseline, convenience] = defaultExceptions(config.etp ?? "strict");
  const applies =
    config.mode !== "retest" && (config.exceptions_baseline ?? baseline);
  return [applies, applies && (config.exceptions_convenience ?? convenience)];
}

/**
 * The overrides the agent applies in every mode, like its
 * exception_overrides: null where the level's default stays.
 */
export function exceptionOverrides(config: ConfigParts) {
  const [baseline, convenience] = appliedExceptions(config);
  const moot = !config.etp || config.etp === "off";
  return {
    exceptions_baseline: moot || baseline ? null : false,
    exceptions_convenience:
      moot || !baseline || convenience === defaultExceptions(config.etp!)[1]
        ? null
        : convenience,
  };
}

/**
 * Which ETP exceptions apply, also when they are the level's default: a label
 * that only named the differences left the reader to know the defaults. Empty
 * with ETP off, where nothing is blocked for an exception to lift.
 */
function exceptionLines(config: ConfigParts): string[] {
  if (!config.etp || config.etp === "off") return [];
  const [baseline, convenience] = appliedExceptions(config);
  if (!baseline) return ["exceptions: off"];
  return [
    convenience
      ? "exceptions: baseline + convenience"
      : "exceptions: baseline only",
  ];
}

/**
 * One line per part, e.g. ["ETP Strict", "+ EasyList", "+ Private Browsing
 * Mode", "exceptions: baseline only"]; empty when the run recorded no target.
 */
export function configLines(config: ConfigParts): string[] {
  if (!config.etp) return [];
  return [
    ETP_LABELS[config.etp],
    ...(config.easylist ? ["+ EasyList"] : []),
    ...(config.easyprivacy ? ["+ EasyPrivacy"] : []),
    ...(config.private ? ["+ Private Browsing Mode"] : []),
    ...exceptionLines(config),
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
 * same kind of window and with the target's ETP exception overrides.
 */
export function baselineConfig(target: ConfigParts): ConfigParts {
  if (!target.etp) return {};
  return {
    etp: target.etp === "strict" ? "standard" : "off",
    private: target.private,
    ...exceptionOverrides(target),
  };
}

/** The same on one line, e.g. "ETP Standard + EasyList + Private Browsing Mode". */
export function configLabel(config: ConfigParts): string {
  // On one line the exceptions part needs a separator; the others start with "+".
  return configLines(config).join(" ").replace(" exceptions:", ", exceptions:");
}

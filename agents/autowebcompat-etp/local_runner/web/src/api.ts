// Types and client for the FastAPI endpoints in ../server.py.

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "cancelled"
  | "interrupted";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * `retest` reruns an old bug with Firefox's ETP exceptions turned off; runs
 * now set `exceptions_baseline: false` instead.
 */
export type Mode = "investigate" | "retest";

/** The ETP category of the configuration the agent investigates. */
export type EtpLevel = "off" | "standard" | "strict";

export type FilterList = "easylist" | "easyprivacy";

export interface RunOptions {
  model: string | null;
  effort: Effort | null;
  max_turns: number | null;
  /** Minutes before the runner stops the run; null: the server's default. */
  timeout_minutes: number | null;
  headless: boolean;
  etp: EtpLevel;
  easylist: boolean;
  easyprivacy: boolean;
  private: boolean;
  /** Whether that ETP exception category applies; null: the level's default. */
  exceptions_baseline: boolean | null;
  exceptions_convenience: boolean | null;
  /** null: natively when the server has a local Firefox. */
  native: boolean | null;
  build: boolean;
}

/** One target configuration; a batch queues a run per bug and configuration. */
export interface TargetConfig {
  etp: EtpLevel;
  easylist: boolean;
  easyprivacy: boolean;
  private: boolean;
  exceptions_baseline: boolean | null;
  exceptions_convenience: boolean | null;
}

export interface RunParams extends Partial<RunOptions> {
  /** Set by older runs; `retest` means the baseline exceptions were off. */
  mode?: Mode;
  bug_id?: number | null;
  bug_data?: string | null;
}

export interface RunInfo {
  run_id: string;
  params: RunParams;
  status: RunStatus;
  queued?: number | null;
  started: number | null;
  finished: number | null;
  turns: number | null;
  cost: number | null;
  active: boolean;
  applied?: boolean;
}

export interface Config {
  artifacts_root: string;
  bugzilla: string;
  env_file: string | null;
  has_anthropic_key: boolean;
  has_bugzilla_key: boolean;
  max_parallel: number;
  /** Limits for a run that sets none; null: no limit. */
  default_max_turns: number | null;
  run_timeout_minutes: number | null;
  local_firefox: string | null;
  /** Setup steps that look skipped or broken; empty when setup is complete. */
  setup_problems: string[];
  query_urls: Record<BugQuery, string>;
}

/** A model the Models API lists, or one of the server's fallbacks. */
export interface ModelInfo {
  id: string;
  display_name: string;
}

export interface ModelList {
  models: ModelInfo[];
  /** The Models API couldn't be reached; these are a fixed list. */
  fallback: boolean;
  error?: string;
}

/** The runner's cached copy of a filter list, which local runs load. */
export interface FilterListInfo {
  name: FilterList;
  label: string;
  url: string;
  present: boolean;
  version: string | null;
  /** File time in seconds. */
  modified: number | null;
}

/** The Bugzilla bug lists runs can be queued from. */
export type BugQuery = "untriaged" | "open";

export interface ProposedException {
  category: "baseline" | "convenience";
  urlPattern: string;
  topLevelUrlPattern: string | null;
  classifierFeatures: string[];
  rationale: string;
}

export interface ProposedShim {
  kind: "opt_in_placeholder" | "stub";
  name: string;
  matches: string[];
  unblocksOnOptIn: string[];
  behavior: string;
  existing_shim_id: string | null;
  rationale: string;
}

export interface EtpResult {
  summary: string;
  failure_reason: string | null;
  broken_in_baseline?: boolean | null;
  broken_in_target?: boolean | null;
  /** Runs from before the baseline/target split. */
  broken_in_standard?: boolean | null;
  broken_in_strict?: boolean | null;
  etp?: EtpLevel;
  filter_lists?: FilterList[];
  private?: boolean;
  mode?: Mode;
  /** Whether each ETP exception category applied (null in older runs). */
  exceptions_baseline?: boolean | null;
  exceptions_convenience?: boolean | null;
  filter_list_versions?: Partial<Record<FilterList, string>> | null;
  /** The Firefox the run drove (absent in older runs). */
  firefox_version?: string | null;
  firefox_build_id?: string | null;
  broken_without_lists?: boolean | null;
  culprit_prefs: string[];
  blocked_resources: string[];
  proposed_exceptions: ProposedException[];
  proposed_shim: ProposedShim | null;
  exception_verified: boolean;
  severity: "S1" | "S2" | "S3" | "S4" | null;
  priority: "P1" | "P2" | "P3" | null;
  steps: string;
  exception_records: Record<string, unknown>[];
  whiteboard_tags: string[];
  user_story_lines: string[];
  existing_exceptions: Record<string, unknown>[] | null;
  existing_shims: Record<string, unknown>[] | null;
  screenshot_urls: Record<string, string>;
}

export interface Summary {
  status: "ok" | "error";
  error: string | null;
  findings: {
    result?: EtpResult;
    num_turns?: number;
    total_cost_usd?: number;
    traceback?: string;
  };
}

export interface AppliedAction {
  action: string;
  stage?: string;
  stages?: string[];
  fields?: string[];
  ids?: number[];
  with_comment?: boolean;
}

export interface Applied {
  applied_at: string;
  bug_id: number;
  url: string;
  actions: AppliedAction[];
  error: string | null;
}

export interface Draft {
  bug_id: number | null;
  comment: string;
  attachments: string[];
  resolution: Resolution | null;
  /** Whether "close the bug" starts ticked. */
  close: boolean;
  /**
   * Whether the outcome calls for needinfo'ing the reporter. Not when the
   * exception tags are added: deploying the exceptions needinfos them later.
   */
  needinfo: boolean;
}

/** The resolutions the bug can be closed with (DUPLICATE needs a dup_id). */
export const RESOLUTIONS = [
  "FIXED",
  "INVALID",
  "WONTFIX",
  "INACTIVE",
  "WORKSFORME",
  "INCOMPLETE",
] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

/** The parts of the draft that need the bug's current fields from Bugzilla. */
export interface BugDraft {
  changes: Record<string, unknown>;
  /** The reporter, who can be needinfo'd to confirm a fix. */
  reporter: string | null;
}

export interface Review {
  summary: Summary;
  result: EtpResult | null;
  screenshots: Record<string, string>;
  screenshot_labels: Record<string, string>;
  has_agent_log: boolean;
  applied: Applied | null;
  draft: Draft;
}

/** One run of a bug, as the compare view lists it. */
export interface CompareRow {
  run_id: string;
  status: RunStatus;
  params: RunParams;
  cost: number | null;
  started: number | null;
  has_result: boolean;
  etp: EtpLevel | null;
  private: boolean | null;
  mode: Mode | null;
  exceptions_baseline: boolean | null;
  exceptions_convenience: boolean | null;
  filter_lists: FilterList[] | null;
  filter_list_versions: Partial<Record<FilterList, string>> | null;
  failure_reason: string | null;
  broken_in_baseline: boolean | null;
  broken_in_target: boolean | null;
  broken_without_lists: boolean | null;
  blocked_trackers: Record<string, number>;
  screenshots: Record<string, string>;
  screenshot_labels: Record<string, string>;
}

export interface ListedBug {
  id: number;
  summary: string;
  creation_time: string;
  last_change_time: string;
  url: string;
  status: string;
  whiteboard: string;
  runs: { run_id: string; status: RunStatus }[];
}

export interface ApplyRequest {
  bug_id: number;
  comment: string;
  changes: Record<string, unknown>;
  attachments: string[];
  resolution: Resolution | null;
  needinfo: string | null;
  force: boolean;
}

/** The target configuration a bug's summary names; null where it names none. */
export interface ReportedConfig {
  summary: string;
  etp: EtpLevel | null;
  private: boolean | null;
}

export interface WhoAmI {
  name: string;
  real_name?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.detail ?? body;
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail)
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const runPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;

export const api = {
  config: () => request<Config>("/api/config"),
  models: () => request<ModelList>("/api/models"),
  filterLists: () => request<FilterListInfo[]>("/api/filter-lists"),
  fetchFilterLists: () => post<FilterListInfo[]>("/api/filter-lists/fetch"),
  whoami: () => request<WhoAmI>("/api/whoami"),
  runs: () => request<RunInfo[]>("/api/runs"),
  startRun: (params: RunParams) => post<RunInfo>("/api/runs", params),
  startBatch: (
    body: RunOptions & { bug_ids: number[]; configs?: TargetConfig[] }
  ) => post<RunInfo[]>("/api/runs/batch", body),
  compare: (bugId: number) =>
    request<CompareRow[]>(`/api/bugs/${bugId}/compare`),
  cancel: (runId: string) => post<RunInfo>(`${runPath(runId)}/cancel`),
  review: (runId: string) => request<Review>(`${runPath(runId)}/review`),
  bugDraft: (runId: string) => request<BugDraft>(`${runPath(runId)}/bug-draft`),
  apply: (runId: string, body: ApplyRequest) =>
    post<Applied>(`${runPath(runId)}/apply`, body),
  bugs: (query: BugQuery) => request<ListedBug[]>(`/api/bugs/${query}`),
  reportedConfig: (bugId: number) =>
    request<ReportedConfig>(`/api/bugs/${bugId}/reported-config`),
  streamUrl: (runId: string) => `${runPath(runId)}/stream`,
  fileUrl: (runId: string, key: string) => `${runPath(runId)}/files/${key}`,
};

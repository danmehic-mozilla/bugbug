// Application state, as one Valtio proxy. Components read it with
// `useSnapshot(store)`; only the functions in ./actions.ts mutate it.

import { proxy } from "valtio";

import type {
  Applied,
  Config,
  FilterListInfo,
  ModelList,
  Review,
  RunInfo,
  RunOptions,
  CompareRow,
  TargetConfig,
  BugQuery,
  ListedBug,
  WhoAmI,
} from "./api";

export const DEFAULT_OPTIONS: RunOptions = {
  model: null,
  effort: null,
  max_turns: null,
  headless: false,
  etp: "strict",
  easylist: false,
  easyprivacy: false,
  private: false,
  exceptions_baseline: null,
  exceptions_convenience: null,
  native: null,
  build: false,
};

/** The draft Bugzilla changes for the selected run, edited before posting. */
export interface ActionsState {
  bugId: string;
  comment: string;
  preview: boolean;
  changes: string;
  attachments: string[];
  addExceptions: boolean;
  force: boolean;
  busy: boolean;
  error: string | null;
  done: Applied | null;
  whoami: WhoAmI | null;
  whoamiError: string | null;
}

/** The selected run: its streamed output, then its result. */
export interface RunState {
  runId: string;
  lines: string[];
  info: RunInfo | null;
  ended: boolean;
  logOpen: boolean;
  cancelError: string | null;
  review: Review | null;
  reviewError: string | null;
  actions: ActionsState | null;
}

export type TriageStep = 1 | 2 | 3;

export interface TriageState {
  query: BugQuery;
  step: TriageStep;
  bugs: ListedBug[];
  selected: number[];
  options: RunOptions;
  configs: TargetConfig[];
  busy: boolean;
  error: string | null;
}

/** The compare view of one bug's runs; `rows` is null while loading. */
export interface CompareState {
  bugId: number;
  rows: CompareRow[] | null;
  error: string | null;
}

export interface StartState {
  bugId: string;
  bugData: string;
  options: RunOptions;
  configs: TargetConfig[];
  busy: boolean;
  error: string | null;
}

/** The runner's cached filter lists, and the "Fetch latest" button's state. */
export interface FilterListsState {
  lists: FilterListInfo[] | null;
  busy: boolean;
  error: string | null;
}

export const store = proxy({
  config: null as Config | null,
  configError: null as string | null,
  models: null as ModelList | null,
  filterLists: { lists: null, busy: false, error: null } as FilterListsState,
  runs: [] as RunInfo[],
  start: {
    bugId: "",
    bugData: "",
    options: { ...DEFAULT_OPTIONS },
    configs: [],
    busy: false,
    error: null,
  } as StartState,
  run: null as RunState | null,
  compare: null as CompareState | null,
  /** The queue-from-Bugzilla dialog, while open. */
  triage: null as TriageState | null,
  /** Wall clock in ms, ticking while a run is in progress. */
  now: Date.now(),
});

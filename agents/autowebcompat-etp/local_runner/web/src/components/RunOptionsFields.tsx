import { useId } from "react";
import { useSnapshot } from "valtio";

import { fetchFilterLists } from "../actions";
import type { Effort, EtpLevel, RunOptions } from "../api";
import {
  baselineConfig,
  configLabel,
  defaultExceptions,
  EFFORTS,
  formatListVersion,
  formatTime,
} from "../format";
import { store } from "../store";

interface Props {
  /** The store's options proxy to edit in place. */
  options: RunOptions;
  buildLabel?: string;
  compact?: boolean;
}

const ETP_LEVELS: [EtpLevel, string][] = [
  ["off", "ETP Off"],
  ["standard", "ETP Standard"],
  ["strict", "ETP Strict"],
];

/** Target configuration, then model / effort / max turns / headless / build, shared by both start flows. */
export function RunOptionsFields({
  options,
  buildLabel = "Rebuild image first",
  compact = false,
}: Props) {
  const snap = useSnapshot(options, { sync: true });
  const { config, models, filterLists } = useSnapshot(store);
  const localFirefox = config?.local_firefox ?? null;
  const native = !!localFirefox && snap.native !== false;
  const runIn = useId();
  const etpName = useId();
  const modelName = models?.models.find((m) => m.id === snap.model);
  // Unchanged checkboxes follow Firefox's default for the level; convenience
  // needs baseline.
  const [defaultBaseline, defaultConvenience] = defaultExceptions(snap.etp);
  const baselineExceptions = snap.exceptions_baseline ?? defaultBaseline;
  const convenienceExceptions =
    baselineExceptions && (snap.exceptions_convenience ?? defaultConvenience);

  const maxTurns = (
    <div>
      <label>Max turns</label>
      <input
        type="number"
        placeholder="default"
        value={snap.max_turns ?? ""}
        onChange={(e) =>
          (options.max_turns = e.target.value ? Number(e.target.value) : null)
        }
      />
    </div>
  );

  return (
    <>
      <h3>Config</h3>
      <label>Target configuration</label>
      {ETP_LEVELS.map(([level, label]) => (
        <label key={level} className="check">
          <input
            type="radio"
            name={etpName}
            checked={snap.etp === level}
            onChange={() => {
              options.etp = level;
              // Without ETP there is nothing to except.
              if (level === "off") {
                options.exceptions_baseline = null;
                options.exceptions_convenience = null;
              }
            }}
          />
          {label}
        </label>
      ))}
      <label className="check">
        <input
          type="checkbox"
          checked={snap.easylist}
          onChange={(e) => (options.easylist = e.target.checked)}
        />
        EasyList
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={snap.easyprivacy}
          onChange={(e) => (options.easyprivacy = e.target.checked)}
        />
        EasyPrivacy
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={snap.private}
          onChange={(e) => (options.private = e.target.checked)}
        />
        Private Browsing Mode
      </label>
      <div className="meta">
        <div>Runs load the runner's cached lists:</div>
        {filterLists.lists?.map((list) => (
          <div
            key={list.name}
            title={list.modified ? `fetched ${formatTime(list.modified)}` : ""}
          >
            {list.label} (
            {list.present
              ? list.version
                ? formatListVersion(list.version)
                : "unknown version"
              : "not cached yet, fetched before the first run that uses it"}
            )
          </div>
        )) ?? <div>…</div>}
        <button
          type="button"
          className="secondary"
          disabled={filterLists.busy}
          onClick={fetchFilterLists}
        >
          {filterLists.busy ? "Fetching…" : "Fetch latest list(s)"}
        </button>
      </div>
      {filterLists.error && (
        <div className="note err">Filter lists: {filterLists.error}</div>
      )}
      <label className="check">
        <input
          type="checkbox"
          disabled={snap.etp === "off"}
          checked={baselineExceptions}
          onChange={(e) => (options.exceptions_baseline = e.target.checked)}
        />
        ETP exceptions: baseline
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={snap.etp === "off" || !baselineExceptions}
          checked={convenienceExceptions}
          onChange={(e) => (options.exceptions_convenience = e.target.checked)}
        />
        ETP exceptions: convenience
      </label>
      {snap.etp !== "off" && !baselineExceptions && (
        <div className="note">
          Baseline exceptions off: this tests as if no ETP exceptions existed
          (use it to check whether an exception is still needed).
        </div>
      )}
      {snap.etp === "strict" && convenienceExceptions && (
        <div className="note">
          Convenience exceptions normally only apply in Strict when a user opts
          in.
        </div>
      )}
      <div className="meta">
        Baseline (should work): {configLabel(baselineConfig(snap))}
      </div>
      {snap.etp === "standard" && !snap.private && (
        <div className="note">
          Standard blocks trackers only in Private Browsing Mode.
        </div>
      )}
      {snap.etp === "off" && !snap.easylist && !snap.easyprivacy && (
        <div className="note">
          Control run: no protections, so no fix is proposed.
        </div>
      )}
      <div className="row">
        <div>
          <label>Model</label>
          <select
            value={snap.model ?? ""}
            onChange={(e) => (options.model = e.target.value || null)}
          >
            <option value="">default</option>
            {snap.model && !modelName && (
              <option value={snap.model}>{snap.model}</option>
            )}
            {models?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name} ({m.id})
              </option>
            ))}
          </select>
          {models?.fallback && (
            <div className="meta" title={models.error}>
              Couldn't list models; showing a fixed list.
            </div>
          )}
        </div>
        <div>
          <label>Effort</label>
          <select
            value={snap.effort ?? ""}
            onChange={(e) =>
              (options.effort = (e.target.value || null) as Effort | null)
            }
          >
            <option value="">default</option>
            {EFFORTS.map((effort) => (
              <option key={effort}>{effort}</option>
            ))}
          </select>
        </div>
        {compact && maxTurns}
      </div>
      {!compact && maxTurns}
      <label className="check">
        <input
          type="checkbox"
          checked={snap.headless}
          onChange={(e) => (options.headless = e.target.checked)}
        />
        Headless Firefox
      </label>
      {localFirefox && (
        <>
          <label>Run in</label>
          <label className="check">
            <input
              type="radio"
              name={runIn}
              checked={native}
              onChange={() => (options.native = true)}
            />
            <span>
              Local build
              <span className="mono path">{localFirefox}</span>
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name={runIn}
              checked={!native}
              onChange={() => (options.native = false)}
            />
            Docker
          </label>
        </>
      )}
      {!native && (
        <label className="check">
          <input
            type="checkbox"
            checked={snap.build}
            onChange={(e) => (options.build = e.target.checked)}
          />
          {buildLabel}
        </label>
      )}
    </>
  );
}

import { useSnapshot } from "valtio";

import { api, type EtpResult, type FilterList, type RunParams } from "../api";
import {
  baselineConfig,
  brokenLabel,
  configLabel,
  formatCost,
  type ConfigParts,
} from "../format";
import { store } from "../store";
import { ConfigLabel } from "./ConfigLabel";
import { CopyButton } from "./CopyButton";

const FILTER_LIST_NAMES = { easylist: "EasyList", easyprivacy: "EasyPrivacy" };

/**
 * The run's target configuration: what it was started with, else what the
 * result records (runs from before the ETP level was a parameter were Strict).
 */
function targetConfig(
  params: RunParams | undefined,
  result:
    | (Pick<
        EtpResult,
        | "etp"
        | "private"
        | "mode"
        | "exceptions_baseline"
        | "exceptions_convenience"
      > & {
        filter_lists?: readonly FilterList[];
      })
    | null
): ConfigParts {
  if (params?.etp) return params;
  const lists = result?.filter_lists ?? [];
  return {
    etp: result?.etp ?? "strict",
    easylist: lists.includes("easylist"),
    easyprivacy: lists.includes("easyprivacy"),
    private: result?.private,
    mode: result?.mode,
    exceptions_baseline: result?.exceptions_baseline,
    exceptions_convenience: result?.exceptions_convenience,
  };
}

/** The target and baseline configurations, one part per line. */
function Configs({ target }: { target: ConfigParts }) {
  return (
    <dl className="kv">
      <dt>Target</dt>
      <dd>
        <ConfigLabel config={target} />
      </dd>
      <dt>Baseline (should work)</dt>
      <dd>
        <ConfigLabel config={baselineConfig(target)} />
      </dd>
    </dl>
  );
}

function Json({
  title,
  value,
  copy = false,
}: {
  title: string;
  value: unknown;
  copy?: boolean;
}) {
  const text = JSON.stringify(value, null, 2);
  return (
    <>
      <h3>
        {title}
        {copy && (
          <>
            {" "}
            <CopyButton text={text} label="copy" />
          </>
        )}
      </h3>
      <pre className="log">{text}</pre>
    </>
  );
}

export function ResultView() {
  const { run, runs } = useSnapshot(store);
  if (!run?.review) return null;
  const { runId, review } = run;
  const { summary, result, screenshots, screenshot_labels } = review;
  const params = (run.info ?? runs.find((r) => r.run_id === runId))?.params;
  const target = targetConfig(params, result);
  const findings = summary.findings;
  const logLink = review.has_agent_log && (
    <p>
      <a href={api.fileUrl(runId, "logs/agent.log")} target="_blank">
        Full agent log
      </a>
    </p>
  );

  if (summary.status !== "ok" || !result) {
    return (
      <>
        <h2>Result</h2>
        <Configs target={target} />
        <div className="note err">
          <b>Run failed:</b> {summary.error}
        </div>
        {findings.traceback && (
          <details>
            <summary>Traceback</summary>
            <pre className="log">{findings.traceback}</pre>
          </details>
        )}
        {logLink}
      </>
    );
  }

  return (
    <>
      <h2>Result</h2>
      <Configs target={target} />
      <div className="card">
        <p>{result.summary}</p>
        <dl className="kv">
          <dt>Outcome</dt>
          <dd>
            {result.failure_reason ? (
              <code>{result.failure_reason}</code>
            ) : (
              <>
                <b className="ok">fix proposed</b> (verified:{" "}
                {String(result.exception_verified)})
              </>
            )}
          </dd>
          <dt>Baseline: {configLabel(baselineConfig(target))}</dt>
          <dd>
            {brokenLabel(
              result.broken_in_baseline ?? result.broken_in_standard ?? null
            )}
          </dd>
          <dt>Target: {configLabel(target)}</dt>
          <dd>
            {brokenLabel(
              result.broken_in_target ?? result.broken_in_strict ?? null
            )}
          </dd>
          {result.broken_without_lists != null && (
            <>
              <dt>Target without lists</dt>
              <dd>{brokenLabel(result.broken_without_lists)}</dd>
            </>
          )}
          {result.private != null && (
            <>
              <dt>Private Browsing Mode</dt>
              <dd>{result.private ? "yes" : "no"}</dd>
            </>
          )}
          {(result.exceptions_baseline != null || result.mode === "retest") && (
            <>
              <dt>ETP exceptions applied</dt>
              <dd>
                baseline: {result.exceptions_baseline ? "yes" : "no"},
                convenience: {result.exceptions_convenience ? "yes" : "no"}
              </dd>
            </>
          )}
          {!!Object.keys(result.filter_list_versions ?? {}).length && (
            <>
              <dt>Filter list versions</dt>
              <dd>
                {Object.entries(result.filter_list_versions ?? {}).map(
                  ([name, version]) => (
                    <div key={name}>
                      {FILTER_LIST_NAMES[name as FilterList] ?? name}:{" "}
                      <code>{version}</code>
                    </div>
                  )
                )}
              </dd>
            </>
          )}
          {result.firefox_build_id && (
            <>
              <dt>Firefox</dt>
              <dd>
                {result.firefox_version} (build{" "}
                <code>{result.firefox_build_id}</code>)
              </dd>
            </>
          )}
          <dt>Severity / priority</dt>
          <dd>
            {result.severity ?? "—"} / {result.priority ?? "—"}
          </dd>
          <dt>Culprit prefs</dt>
          <dd>
            {result.culprit_prefs.length
              ? result.culprit_prefs.map((pref, i) => (
                  <span key={pref}>
                    {i > 0 && ", "}
                    <code>{pref}</code>
                  </span>
                ))
              : "—"}
          </dd>
          <dt>Blocked</dt>
          <dd>
            {result.blocked_resources.length
              ? result.blocked_resources.map((resource) => (
                  <div key={resource}>{resource}</div>
                ))
              : "—"}
          </dd>
          <dt>Turns / cost</dt>
          <dd>
            {findings.num_turns ?? "—"} /{" "}
            {formatCost(findings.total_cost_usd, 4)}
          </dd>
        </dl>
        {logLink}
      </div>

      {result.exception_records.length > 0 && (
        <Json
          title="Proposed exception records"
          value={result.exception_records}
        />
      )}
      {result.proposed_shim && (
        <Json title="Proposed shim" value={result.proposed_shim} copy />
      )}
      {result.existing_exceptions === null && (
        <div className="note">Could not fetch the existing exception list.</div>
      )}
      {!!result.existing_exceptions?.length && (
        <Json
          title="Overlapping existing exceptions"
          value={result.existing_exceptions}
        />
      )}
      {!!result.existing_shims?.length && (
        <Json
          title="Overlapping existing shims"
          value={result.existing_shims}
          copy
        />
      )}

      {Object.keys(screenshots).length > 0 && (
        <>
          <h3>Screenshots</h3>
          <div className="shots">
            {Object.entries(screenshots).map(([stage, key]) => (
              <figure key={stage}>
                <a href={api.fileUrl(runId, key)} target="_blank">
                  <img src={api.fileUrl(runId, key)} alt={stage} />
                </a>
                <figcaption>{screenshot_labels[stage] ?? stage}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      <details>
        <summary>Steps</summary>
        <pre className="steps-text">{result.steps}</pre>
      </details>
    </>
  );
}

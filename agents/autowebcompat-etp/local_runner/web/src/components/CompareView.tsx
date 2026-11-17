import { useSnapshot } from "valtio";

import { closeCompare, selectRun } from "../actions";
import { api, type CompareRow, type FilterList } from "../api";
import { baselineConfig, configLabel, formatCost } from "../format";
import { store } from "../store";
import { ConfigLabel } from "./ConfigLabel";
import { StatusBadge } from "./StatusBadge";

function rowConfig(row: {
  params: CompareRow["params"];
  etp: CompareRow["etp"];
  private: CompareRow["private"];
  filter_lists: readonly FilterList[] | null;
}) {
  const lists = row.filter_lists ?? [];
  return row.params.etp
    ? row.params
    : {
        etp: row.etp,
        easylist: lists.includes("easylist"),
        easyprivacy: lists.includes("easyprivacy"),
        private: row.private,
      };
}

const LIST_NAMES: Record<string, string> = {
  easylist: "EasyList",
  easyprivacy: "EasyPrivacy",
};

/** Broken / works / not tested, as a colored pill with an icon. */
function Verdict({ value }: { value: boolean | null | undefined }) {
  if (value === true) return <span className="verdict broken">✗ Broken</span>;
  if (value === false) return <span className="verdict works">✓ Works</span>;
  return <span className="verdict untested">– Not tested</span>;
}

/** 202611171744 -> 2026-11-17 17:44; anything else unchanged. */
function formatListVersion(version: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : version;
}

/** One row per run of a bug, to compare how each target configuration behaves. */
export function CompareView() {
  const { compare } = useSnapshot(store);
  if (!compare) return null;
  return (
    <>
      <h1>Bug {compare.bugId}: compare runs</h1>
      <p className="meta">
        <a href="#" onClick={(e) => (e.preventDefault(), closeCompare())}>
          Back
        </a>
      </p>
      {compare.error && <div className="note err">{compare.error}</div>}
      {!compare.rows && !compare.error && <p>Loading…</p>}
      {compare.rows && !compare.rows.length && <p>No runs for this bug.</p>}
      {!!compare.rows?.length && (
        <table className="bugs">
          <thead>
            <tr>
              <th title="The target configuration the run tested">
                Configuration
              </th>
              <th title="Where the site should work: ETP Standard for a Strict target, else ETP Off without lists">
                Baseline
              </th>
              <th title="Whether the reported breakage happens in the target configuration">
                Target
              </th>
              <th title="Only for a broken target with filter lists: the same ETP level without them. Works means the lists alone cause it">
                Target without lists
              </th>
              <th title="Trackers Firefox blocked at each screenshot">
                Blocked trackers
              </th>
              <th title="The EasyList / EasyPrivacy versions loaded">
                List versions
              </th>
              <th>Screenshots</th>
              <th title="ok means the run finished, not that the site works">
                Status / cost
              </th>
            </tr>
          </thead>
          <tbody>
            {compare.rows.map((row) => (
              <tr key={row.run_id}>
                <td>
                  <a
                    href={`#${encodeURIComponent(row.run_id)}`}
                    onClick={(e) => (e.preventDefault(), selectRun(row.run_id))}
                    title={row.run_id}
                  >
                    {rowConfig(row).etp ? (
                      <ConfigLabel config={rowConfig(row)} />
                    ) : (
                      row.run_id
                    )}
                  </a>
                </td>
                <td>
                  {row.has_result ? (
                    <Verdict value={row.broken_in_baseline} />
                  ) : (
                    <span className="meta">—</span>
                  )}
                  {configLabel(baselineConfig(rowConfig(row))) && (
                    <div className="meta">
                      {configLabel(baselineConfig(rowConfig(row)))}
                    </div>
                  )}
                </td>
                <td>
                  {row.has_result ? (
                    <Verdict value={row.broken_in_target} />
                  ) : (
                    <span className="meta">—</span>
                  )}
                </td>
                <td>
                  {row.broken_without_lists == null ? (
                    <span className="meta">—</span>
                  ) : (
                    <Verdict value={row.broken_without_lists} />
                  )}
                </td>
                <td>
                  {Object.entries(row.blocked_trackers)
                    .filter(([, n]) => n != null)
                    .map(([stage, n]) => (
                      <span
                        key={stage}
                        className="chip"
                        title={`Blocked trackers at the ${stage} screenshot`}
                      >
                        {stage} <b>{n}</b>
                      </span>
                    ))}
                </td>
                <td>
                  {Object.entries(row.filter_list_versions ?? {}).map(
                    ([name, version]) => (
                      <span key={name} className="chip" title={version}>
                        {LIST_NAMES[name] ?? name}{" "}
                        <b>{formatListVersion(version)}</b>
                      </span>
                    )
                  )}
                </td>
                <td>
                  <div className="thumbs">
                    {Object.entries(row.screenshots).map(([stage, key]) => (
                      <a
                        key={stage}
                        href={api.fileUrl(row.run_id, key)}
                        target="_blank"
                        title={row.screenshot_labels[stage] ?? stage}
                      >
                        <img
                          className="thumb"
                          src={api.fileUrl(row.run_id, key)}
                          alt={stage}
                        />
                        <span className="meta">{stage}</span>
                      </a>
                    ))}
                  </div>
                </td>
                <td>
                  <StatusBadge status={row.status} /> {formatCost(row.cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

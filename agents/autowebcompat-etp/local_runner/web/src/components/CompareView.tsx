import { useSnapshot } from "valtio";

import { closeCompare, selectRun } from "../actions";
import { api, type CompareRow, type FilterList } from "../api";
import { brokenLabel, configLabel, formatCost } from "../format";
import { store } from "../store";
import { StatusBadge } from "./StatusBadge";

function rowConfig(row: {
  params: CompareRow["params"];
  etp: CompareRow["etp"];
  private: CompareRow["private"];
  filter_lists: readonly FilterList[] | null;
}): string {
  const lists = row.filter_lists ?? [];
  return configLabel(
    row.params.etp
      ? row.params
      : {
          etp: row.etp,
          easylist: lists.includes("easylist"),
          easyprivacy: lists.includes("easyprivacy"),
          private: row.private,
        }
  );
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
              <th>Configuration</th>
              <th>Baseline</th>
              <th>Target</th>
              <th>Target without lists</th>
              <th>Blocked trackers</th>
              <th>List versions</th>
              <th>Screenshots</th>
              <th>Status / cost</th>
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
                    {rowConfig(row) || row.run_id}
                  </a>
                </td>
                <td>
                  {row.has_result ? brokenLabel(row.broken_in_baseline) : ""}
                </td>
                <td>
                  {row.has_result ? brokenLabel(row.broken_in_target) : ""}
                </td>
                <td>
                  {row.broken_without_lists == null
                    ? "—"
                    : brokenLabel(row.broken_without_lists)}
                </td>
                <td className="meta">
                  {Object.entries(row.blocked_trackers).map(([stage, n]) => (
                    <div key={stage}>
                      {stage}: {n}
                    </div>
                  ))}
                </td>
                <td className="meta">
                  {Object.entries(row.filter_list_versions ?? {}).map(
                    ([name, version]) => (
                      <div key={name}>
                        {name}: {version}
                      </div>
                    )
                  )}
                </td>
                <td>
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
                    </a>
                  ))}
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

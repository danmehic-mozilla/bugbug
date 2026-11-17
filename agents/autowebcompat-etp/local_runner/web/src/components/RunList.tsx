import { useState } from "react";
import { useSnapshot } from "valtio";

import { selectRun } from "../actions";
import { formatCost, formatTime } from "../format";
import { store } from "../store";
import { ConfigLabel } from "./ConfigLabel";
import { RunBadges } from "./StatusBadge";

/** How many of the latest runs the list shows until it is expanded. */
const RECENT_RUNS = 5;

export function RunList() {
  const { runs, run: selected } = useSnapshot(store);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const recent = runs.slice(0, RECENT_RUNS);
  // Keep the selected run in view even if it is older than the latest ones.
  const older = runs.find(
    (r) => r.run_id === selected?.runId && !recent.includes(r)
  );
  const shown = showAll ? runs : older ? [...recent, older] : recent;
  return (
    <>
      <h2>
        <button
          type="button"
          className="toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"} Runs{runs.length ? ` (${runs.length})` : ""}
        </button>
      </h2>
      {open && !runs.length && <p className="meta">No runs yet.</p>}
      {open && !!runs.length && (
        <>
          <ul className="runs">
            {shown.map((run) => (
        <li
          key={run.run_id}
          className={run.run_id === selected?.runId ? "sel" : ""}
          onClick={() => selectRun(run.run_id)}
        >
          <div className="id">{run.run_id}</div>
          <ConfigLabel config={run.params} className="meta" />
          <div className="meta">
            <RunBadges run={run} /> {formatTime(run.started ?? run.queued)}
            {run.turns ? ` · ${run.turns} turns` : ""}
            {run.cost ? ` · ${formatCost(run.cost)}` : ""}
          </div>
        </li>
            ))}
          </ul>
          {runs.length > RECENT_RUNS && (
            <p className="meta">
              <a
                href="#"
                onClick={(e) => (e.preventDefault(), setShowAll(!showAll))}
              >
                {showAll
                  ? `Show the latest ${RECENT_RUNS}`
                  : `Show all ${runs.length} runs`}
              </a>
            </p>
          )}
        </>
      )}
    </>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { useSnapshot } from "valtio";

import { startRun } from "../actions";
import { api, type EtpLevel, type ReportedConfig } from "../api";
import { configLabel } from "../format";
import { store } from "../store";
import { ConfigsToCompare } from "./ConfigsToCompare";
import { RunOptionsFields } from "./RunOptionsFields";

/** e.g. "ETP Standard + Private Browsing Mode"; only the parts given. */
function describe(etp: EtpLevel | null, isPrivate: boolean | null): string {
  return [
    ...(etp ? [configLabel({ etp })] : []),
    ...(isPrivate === true ? ["Private Browsing Mode"] : []),
    ...(isPrivate === false ? ["normal window"] : []),
  ].join(" + ");
}

export function StartForm() {
  const start = store.start;
  const snap = useSnapshot(start, { sync: true });
  const [reported, setReported] = useState<ReportedConfig | null>(null);

  // Suggest the configuration the report names, once the bug ID settles.
  useEffect(() => {
    setReported(null);
    const bugId = Number(snap.bugId);
    if (!snap.bugId || !Number.isInteger(bugId) || bugId <= 0) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .reportedConfig(bugId)
        .then((found) => current && setReported(found))
        .catch(() => {});
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [snap.bugId]);

  const detected = !!reported && (!!reported.etp || reported.private != null);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Compared configurations each set their own target.
    if (reported && detected && !start.configs.length) {
      const { etp, private: isPrivate } = start.options;
      const etpDiffers = !!reported.etp && reported.etp !== etp;
      const privateDiffers =
        reported.private != null && reported.private !== isPrivate;
      if (
        (etpDiffers || privateDiffers) &&
        !window.confirm(
          `The report says ${describe(reported.etp, reported.private)}; ` +
            `you picked ${describe(
              reported.etp ? etp : null,
              reported.private != null ? isPrivate : null
            )}. Start anyway?`
        )
      )
        return;
    }
    startRun();
  }

  function applyReported() {
    if (!reported) return;
    if (reported.etp) start.options.etp = reported.etp;
    if (reported.private != null) start.options.private = reported.private;
  }

  return (
    <form onSubmit={submit}>
      <label>Bug ID</label>
      <input
        type="number"
        placeholder="e.g. 1900000"
        value={snap.bugId}
        onChange={(e) => (start.bugId = e.target.value)}
      />
      {reported && (
        <div className="meta summary-line" title={reported.summary}>
          {reported.summary}
        </div>
      )}
      {reported && detected && (
        <div className="meta">
          Reported: {describe(reported.etp, reported.private)}{" "}
          <button type="button" className="secondary" onClick={applyReported}>
            Use this
          </button>
        </div>
      )}
      <details>
        <summary className="meta">…or paste report text instead</summary>
        <textarea
          rows={5}
          placeholder="Report text (BUG_DATA)"
          value={snap.bugData}
          onChange={(e) => (start.bugData = e.target.value)}
        />
      </details>
      <RunOptionsFields options={start.options} />
      <ConfigsToCompare options={start.options} configs={start.configs} />
      {snap.error && <div className="note err">{snap.error}</div>}
      <button type="submit" className="wide" disabled={snap.busy}>
        Start run
      </button>
    </form>
  );
}

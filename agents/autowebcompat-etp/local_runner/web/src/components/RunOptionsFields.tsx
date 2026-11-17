import { useId } from "react";
import { useSnapshot } from "valtio";

import type { Effort, EtpLevel, RunOptions } from "../api";
import { EFFORTS } from "../format";
import { store } from "../store";

interface Props {
  /** The store's options proxy to edit in place. */
  options: RunOptions;
  buildLabel?: string;
  compact?: boolean;
}

const ETP_LEVELS: [EtpLevel, string][] = [
  ["off", "ETP off"],
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
  const localFirefox = useSnapshot(store).config?.local_firefox ?? null;
  const native = !!localFirefox && snap.native !== false;
  const runIn = useId();
  const etpName = useId();

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
              // Retesting disables ETP's exceptions, which is moot without ETP.
              if (level === "off") options.mode = "investigate";
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
        Private window
      </label>
      {snap.etp === "standard" && !snap.private && (
        <div className="note">
          Standard blocks trackers only in private windows.
        </div>
      )}
      {snap.etp === "off" && !snap.easylist && !snap.easyprivacy && (
        <div className="note">
          Control run: no protections, so no fix is proposed.
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          disabled={snap.etp === "off"}
          checked={snap.mode === "retest"}
          onChange={(e) =>
            (options.mode = e.target.checked ? "retest" : "investigate")
          }
        />
        Retest with ETP exceptions disabled
      </label>
      <div className="row">
        <div>
          <label>Model</label>
          <input
            placeholder="default"
            value={snap.model ?? ""}
            onChange={(e) => (options.model = e.target.value || null)}
          />
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
            Local build <span className="mono">{localFirefox}</span>
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

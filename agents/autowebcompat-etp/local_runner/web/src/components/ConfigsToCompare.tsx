import { useSnapshot } from "valtio";

import { addConfig } from "../actions";
import type { RunOptions, TargetConfig } from "../api";
import { configLabel } from "../format";

interface Props {
  options: RunOptions;
  configs: TargetConfig[];
}

/**
 * Optional list of target configurations: with any listed, one run is queued
 * per bug and configuration instead of one for the form's own target.
 */
export function ConfigsToCompare({ options, configs }: Props) {
  const snap = useSnapshot(configs, { sync: true });
  return (
    <>
      <label>Compare configurations</label>
      {snap.map((config, i) => (
        <div key={configLabel(config)} className="check">
          {configLabel(config)}
          <button
            type="button"
            className="secondary"
            title="Remove"
            onClick={() => configs.splice(i, 1)}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary wide"
        onClick={() => addConfig(configs, options)}
      >
        Add the configuration above
      </button>
      {snap.length > 0 && (
        <div className="meta">
          One run per bug for each listed configuration; the target above is not
          queued on its own.
        </div>
      )}
    </>
  );
}

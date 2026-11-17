import { configLines } from "../format";

type Props = { config: Parameters<typeof configLines>[0]; className?: string };

/** A target configuration with each part on its own line. */
export function ConfigLabel({ config, className }: Props) {
  const lines = configLines(config);
  if (!lines.length) return null;
  return (
    <div className={className}>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

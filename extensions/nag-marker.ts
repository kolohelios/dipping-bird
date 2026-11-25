import { appendFile } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type NagMarker = Readonly<{
  timestamp: string;
  session_file: string;
  entry_id: string;
}>;
export type MarkerWriter = (marker: NagMarker) => Promise<void>;

export function markerForNag(
  sessionFile: string | undefined,
  branch: readonly SessionEntry[],
): NagMarker | undefined {
  if (!sessionFile) return undefined;
  const entry = branch.findLast(
    (item) => item.type === "custom_message" && item.customType === "pi-nag",
  );
  if (entry?.type !== "custom_message") return undefined;
  return {
    timestamp: entry.timestamp,
    session_file: sessionFile,
    entry_id: entry.id,
  };
}

export async function appendNagMarker(
  marker: NagMarker,
  append: (
    path: string,
    data: string,
    options: { mode: number },
  ) => Promise<void> = appendFile,
): Promise<void> {
  await append(
    `${marker.session_file.replace(/\.jsonl$/, "")}.nags`,
    `${JSON.stringify(marker)}\n`,
    { mode: 0o600 },
  );
}

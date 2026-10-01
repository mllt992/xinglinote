import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const filename = ".worker-heartbeat.json";
export async function writeWorkerHeartbeat(dataDir: string, now = Date.now()) {
  await mkdir(dataDir, { recursive: true });
  const temp = join(dataDir, `${filename}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify({ at: now }), { mode: 0o600 });
  await rename(temp, join(dataDir, filename));
}
export async function readWorkerHeartbeat(dataDir: string): Promise<number | null> {
  try { const value = JSON.parse(await readFile(join(dataDir, filename), "utf8")) as { at?: number }; return typeof value.at === "number" && Number.isFinite(value.at) ? value.at : null; } catch { return null; }
}

/**
 * Error logger — writes errors to daily log files for debugging.
 * Logs go to: <logDir>/YYYY-MM-DD.log
 */
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_DIR = path.join(
  process.env.HOME || "/tmp",
  ".cursor-api-proxy",
  "logs",
);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  ensureDir(LOG_DIR);
  return path.join(LOG_DIR, `${date}.log`);
}

export function logError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const entry = {
    ts,
    context,
    error: errMsg,
    ...(stack ? { stack } : {}),
    ...(extra || {}),
  };

  const line = JSON.stringify(entry) + "\n";

  try {
    fs.appendFileSync(getLogPath(), line);
  } catch {
    // fallback to console if file write fails
    console.error(`[error-log] ${line}`);
  }

  // Also print to console
  console.error(`[${ts}] [${context}] ${errMsg}`);
}

export function logEvent(context: string, data: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry = { ts, context, ...data };
  const line = JSON.stringify(entry) + "\n";

  try {
    fs.appendFileSync(getLogPath(), line);
  } catch {
    console.error(`[error-log] ${line}`);
  }
}

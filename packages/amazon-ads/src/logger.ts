/**
 * Strukturiertes Logging, kompatibel mit dem Logger der API (`apps/api/src/logger.ts`).
 * Das Paket loggt nie Header, Query-Strings oder Bodies: Dort stehen Tokens und Secrets.
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  [key: string]: unknown;
}

export type Logger = (entry: LogEntry) => void;

export const noopLogger: Logger = () => {};

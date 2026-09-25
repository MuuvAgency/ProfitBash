/**
 * Strukturiertes Logging als JSON-Zeilen. Nie Secrets, Tokens oder Query-Strings loggen
 * (OAuth-Callbacks tragen den Code im Query-String).
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

export type Logger = (entry: LogEntry) => void;

export const consoleLogger: Logger = (entry) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === 'error') console.error(line);
  else console.log(line);
};

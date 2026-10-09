import { z } from 'zod';
import { sanitize } from './http';
import { amazonIdSchema } from './profiles';
import type { AmazonAdsWriteOperation, AmazonAdsWriteResult } from './writes';

/**
 * Bausteine der Schreib-Endpunkte (`docs/tasks/phase-3.md` 3.2a und 3.2c, ADR 005): Form eines Endpunkts, Abbildung
 * je Anzeigentyp (`WriteDialect`) und das Lesen der Antwortformen von Amazon. Senden und Stückeln macht `writes.ts`.
 */

export type ItemOutcome = AmazonAdsWriteResult extends infer R
  ? R extends { ref: string }
    ? Omit<R, 'ref'>
    : never
  : never;

export interface Pending {
  /** Position in `operations` (und im Ergebnis). */
  position: number;
  ref: string;
  /** Eintrag im Body bzw. ID im Filter. */
  item: unknown;
  /** ID der geänderten Entity (Updates, Archivieren); `null` bei Anlagen. */
  amazonId: string | null;
}

export interface Endpoint {
  operation: string;
  method: 'PUT' | 'POST';
  path: string;
  contentType: string;
  accept: string;
  /** Höchstzahl der Einträge je Aufruf. */
  batchSize: number;
  /** 5xx und Netzwerkfehler wiederholen (nur, wenn eine Wiederholung nichts doppelt anlegt). */
  idempotent: boolean;
  body: (items: unknown[]) => unknown;
  /** Liest die Antwort: je Eintrag des Stücks ein Ergebnis; `null`, wenn sie nicht lesbar ist. */
  read: (response: unknown, batch: readonly Pending[]) => ItemOutcome[] | null;
}

/** Eine Änderung, abgebildet auf ihren Endpunkt. */
export interface MappedOperation {
  endpoint: Endpoint;
  item: unknown;
  amazonId: string | null;
}

/** Abbildung der Änderungen eines Anzeigentyps. */
export interface WriteDialect {
  /**
   * Endpunkt und Eintrag einer Änderung; `null`, wenn sie kein Feld nennt. Wirft `TypeError` bei ungültigen Werten
   * und `WriteNotSupportedError`, wenn es die Änderung für den Anzeigentyp nicht gibt.
   */
  map: (op: AmazonAdsWriteOperation) => MappedOperation | null;
  /** Reihenfolge der Aufrufe: erst Updates (Kampagne vor ihren Kindern), dann Archivieren, zuletzt Anlagen. */
  order: readonly Endpoint[];
}

/** Die Änderung gibt es für diesen Anzeigentyp nicht (z. B. Gebotsstrategie bei SB, Keywords bei SD). */
export class WriteNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteNotSupportedError';
  }
}

export function requireId(value: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError('Amazon-ID besteht nicht nur aus Ziffern.');
  return value;
}

const MAX_MESSAGE_LENGTH = 300;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** Text von Amazon für die Anzeige: ohne Steuerzeichen und Tokens, Leerraum zusammengefasst, gekürzt. */
export function cleanMessage(text: string): string {
  return sanitize(text.replace(/\s+/gu, ' ').trim(), MAX_MESSAGE_LENGTH - 1);
}

export const errorCode = (...candidates: unknown[]): string =>
  candidates.find(
    (value): value is string => typeof value === 'string' && ERROR_CODE.test(value),
  ) ?? 'UNKNOWN';

const NO_REASON = 'Amazon hat die Änderung ohne Begründung abgelehnt.';

/** Eine Zeile der Antwort, schon dem Eintrag des Stücks (`index`) zugeordnet. */
export type ResponseEntry =
  { index: number; ok: true; id: unknown } | { index: number; ok: false; outcome: ItemOutcome };

/**
 * Ergebnisse eines Stücks aus den Zeilen der Antwort: fehlt ein Eintrag, nennt Amazon für ein Update eine andere ID
 * oder einen Eintrag mehrfach, gilt der Ausgang als unklar.
 */
export function collectOutcomes(
  batch: readonly Pending[],
  entries: readonly ResponseEntry[],
): ItemOutcome[] {
  const outcomes: ItemOutcome[] = batch.map(() => ({
    status: 'unknown',
    message: 'Amazon hat für diese Änderung kein Ergebnis genannt.',
  }));
  /** Wie oft die Antwort einen Eintrag nennt: mehr als einmal ist widersprüchlich. */
  const mentions = new Map<number, number>();
  for (const entry of entries) {
    const pending = batch[entry.index];
    if (!pending) continue;
    mentions.set(entry.index, (mentions.get(entry.index) ?? 0) + 1);
    if (!entry.ok) {
      outcomes[entry.index] = entry.outcome;
      continue;
    }
    const id = amazonIdSchema.safeParse(entry.id);
    outcomes[entry.index] =
      pending.amazonId !== null && id.success && id.data !== pending.amazonId
        ? { status: 'unknown', message: 'Amazon hat für diese Änderung eine andere ID genannt.' }
        : { status: 'applied', amazonId: id.success ? id.data : pending.amazonId };
  }
  for (const [index, count] of mentions) {
    if (count > 1) {
      outcomes[index] = {
        status: 'unknown',
        message: 'Amazon hat für diese Änderung widersprüchliche Ergebnisse genannt.',
      };
    }
  }
  return outcomes;
}

// --- Antwort mit `success`/`error` je `index` (SP v3, SB v4) ---------------------------------

const mutationErrorSchema = z.looseObject({
  errorType: z.string().nullish(),
  errorValue: z.record(z.string(), z.unknown()).nullish(),
});

const mutationResultSchema = z.object({
  success: z
    .array(z.looseObject({ index: z.int().min(0) }))
    .nullish()
    .transform((value) => value ?? []),
  error: z
    .array(z.looseObject({ index: z.int().min(0), errors: z.array(mutationErrorSchema).nullish() }))
    .nullish()
    .transform((value) => value ?? []),
});

/** Ergebnis eines Fehler-Eintrags der 207-Antwort. */
function failureOf(errors: z.output<typeof mutationErrorSchema>[] | null | undefined): ItemOutcome {
  const first = errors?.[0];
  const errorType = first?.errorType ?? null;
  const detail = errorType ? first?.errorValue?.[errorType] : undefined;
  const fields =
    typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
  const message = typeof fields.message === 'string' ? cleanMessage(fields.message) : '';
  // Kein Urteil über die Änderung: Amazon hat sie gedrosselt bzw. ist selbst gescheitert.
  if (errorType === 'throttledError') return { status: 'unsent' };
  if (errorType === 'internalServerError') {
    return { status: 'unknown', message: message || 'Interner Fehler bei Amazon.' };
  }
  return {
    status: 'failed',
    code: errorCode(fields.reason, errorType),
    message: message || NO_REASON,
  };
}

/**
 * `{ <responseKey>: { success: [{ index, <idKey> }], error: [{ index, errors }] } }`. Gelesen wird nur der Schlüssel
 * des Endpunkts; weitere Felder der Antwort stören nicht.
 */
export function indexedReader(responseKey: string, idKey: string): Endpoint['read'] {
  return (response, batch) => {
    if (typeof response !== 'object' || response === null) return null;
    const parsed = mutationResultSchema.safeParse(
      (response as Record<string, unknown>)[responseKey],
    );
    if (!parsed.success) return null;
    return collectOutcomes(batch, [
      ...parsed.data.success.map((success): ResponseEntry => ({
        index: success.index,
        ok: true,
        id: success[idKey],
      })),
      ...parsed.data.error.map((failure): ResponseEntry => ({
        index: failure.index,
        ok: false,
        outcome: failureOf(failure.errors),
      })),
    ]);
  };
}

/** Ergebnis eines abgelehnten Eintrags mit einfachem Code und Text (SB v3, SD). */
export function flatFailure(code: unknown, text: unknown): ItemOutcome {
  const message = typeof text === 'string' ? cleanMessage(text) : '';
  if (typeof code === 'string' && /throttl/i.test(code)) return { status: 'unsent' };
  if (typeof code === 'string' && /^(internal|server)/i.test(code)) {
    return { status: 'unknown', message: message || 'Interner Fehler bei Amazon.' };
  }
  return { status: 'failed', code: errorCode(code), message: message || NO_REASON };
}

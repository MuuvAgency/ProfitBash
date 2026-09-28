/**
 * Vergleich von Decimal-Strings ohne Umweg über `number` (`phase-2.md` F7): Sortieren und Filtern von Beträgen im
 * Browser. Das Web bekommt kein `decimal.js` (ADR 003); die Werte kommen aus der API als `-?\d+(\.\d+)?`.
 */

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

interface Parts {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parse(value: string): Parts {
  const match = DECIMAL.exec(value);
  if (!match) throw new TypeError(`Kein Decimal-String: ${value}`);
  const integer = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const zero = integer === '0' && fraction === '';
  return { negative: match[1] === '-' && !zero, integer, fraction };
}

/** Betrag ohne Vorzeichen: erst Stellen vor dem Komma, dann ziffernweise. */
function compareMagnitude(a: Parts, b: Parts): number {
  if (a.integer.length !== b.integer.length) return a.integer.length - b.integer.length;
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const fa = a.fraction.padEnd(length, '0');
  const fb = b.fraction.padEnd(length, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** Negativ, 0 oder positiv wie `a - b`. Wirft `TypeError` bei Werten, die kein Decimal-String sind. */
export function compareDecimal(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.negative !== pb.negative) return pa.negative ? -1 : 1;
  const magnitude = compareMagnitude(pa, pb);
  return pa.negative ? -magnitude : magnitude;
}

/**
 * Vergleich für Grid-Spalten (Signatur wie der `comparator` von AG Grid): Fehlende Werte stehen in beide Richtungen
 * am Ende. AG Grid kehrt das Ergebnis bei absteigender Sortierung um, deshalb gilt `null` dann als kleiner.
 */
export function compareDecimalNullsLast(
  a: string | null | undefined,
  b: string | null | undefined,
  isDescending = false,
): number {
  const missingA = a === null || a === undefined;
  const missingB = b === null || b === undefined;
  if (missingA || missingB) {
    if (missingA && missingB) return 0;
    const last = isDescending ? -1 : 1;
    return missingA ? last : -last;
  }
  return compareDecimal(a, b);
}

/** Vorzeichen eines Decimal-Strings (`-1`, `0`, `1`), `null` bei fehlendem Wert. */
export function decimalSign(value: string | null | undefined): -1 | 0 | 1 | null {
  if (value === null || value === undefined) return null;
  const parts = parse(value);
  if (parts.integer === '0' && parts.fraction === '') return 0;
  return parts.negative ? -1 : 1;
}

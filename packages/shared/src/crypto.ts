import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Verschlüsselung für Secrets in der Datenbank (z. B. Amazon-Refresh-Tokens). Nur Server
 * (`@profitbash/shared/crypto`, nutzt `node:crypto`).
 *
 * Format: `v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url), AES-256-GCM.
 * - `keyId` erlaubt Schlüsselrotation: Neue Werte nutzen den aktuellen Schlüssel, alte werden mit
 *   den vorherigen Schlüsseln entschlüsselt und können neu verschlüsselt werden.
 * - Die AAD bindet den Ciphertext an seinen Ort (z. B. den natürlichen Schlüssel einer Connection).
 *   Ein kopierter Wert lässt sich an keiner anderen Stelle entschlüsseln.
 *
 * Fehlerarten: `KeyringError` (Konfiguration), `DecryptionError` (Daten), `TypeError` (Programmierfehler
 * wie leere AAD). Keine Meldung enthält Schlüssel, Klartext oder ungeprüfte Werte aus dem Ciphertext.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface EncryptionKey {
  id: string;
  key: Buffer;
}

export interface Keyring {
  /** Wird zum Verschlüsseln genutzt. */
  current: EncryptionKey;
  /** Nur zum Entschlüsseln (Rotation). */
  previous: EncryptionKey[];
}

export interface KeyringEnv {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_ID: string;
  /** `id:base64key,id:base64key` – frühere Schlüssel, nur zum Entschlüsseln. */
  ENCRYPTION_KEYS_PREVIOUS?: string | undefined;
}

/** Fehler in der Schlüsselkonfiguration. Meldungen enthalten nie Schlüsselmaterial. */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/** Entschlüsseln fehlgeschlagen. Meldungen enthalten nie Klartext, Schlüssel oder ungeprüfte Werte. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Dekodiert Base64/Base64url streng: Nur wenn das Neu-Kodieren exakt denselben String ergibt, ist der
 * Wert gültig. Node ignoriert sonst fremde Zeichen und ungenutzte Bits, sodass verschiedene Strings
 * denselben Wert ergäben.
 */
function decodeStrict(value: string, encoding: 'base64' | 'base64url'): Buffer | null {
  const decoded = Buffer.from(value, encoding);
  return decoded.toString(encoding) === value ? decoded : null;
}

function parseKey(id: string, base64Key: string, source: string): EncryptionKey {
  if (!KEY_ID_PATTERN.test(id)) {
    throw new KeyringError(
      `${source}: ungültige Schlüssel-ID (erlaubt: A-Z, a-z, 0-9, _ und -, höchstens 32 Zeichen).`,
    );
  }
  const key = decodeStrict(base64Key.trim(), 'base64');
  if (key === null) {
    throw new KeyringError(`${source}: Schlüssel "${id}" ist kein gültiges Base64.`);
  }
  if (key.length !== KEY_BYTES) {
    throw new KeyringError(
      `${source}: Schlüssel "${id}" muss genau ${KEY_BYTES} Byte lang sein (openssl rand -base64 32).`,
    );
  }
  return { id, key };
}

/** Liest und prüft die Schlüssel aus der Umgebung. */
export function parseKeyring(env: KeyringEnv): Keyring {
  const current = parseKey(env.ENCRYPTION_KEY_ID, env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');

  const previous = (env.ENCRYPTION_KEYS_PREVIOUS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) {
        throw new KeyringError(
          'ENCRYPTION_KEYS_PREVIOUS: Einträge im Format id:base64key angeben.',
        );
      }
      return parseKey(
        entry.slice(0, separator),
        entry.slice(separator + 1),
        'ENCRYPTION_KEYS_PREVIOUS',
      );
    });

  const ids = new Set<string>([current.id]);
  for (const { id } of previous) {
    if (ids.has(id)) throw new KeyringError(`Schlüssel-ID "${id}" ist mehrfach vergeben.`);
    ids.add(id);
  }

  return { current, previous };
}

/** Natürlicher Schlüssel einer Connection. Vor dem Einfügen bekannt und stabil bei Upserts. */
export interface ConnectionAadInput {
  organizationId: string;
  provider: string;
  region: string | null;
  externalAccountId: string;
}

/**
 * AAD für den Refresh-Token einer Connection. Bindet an den natürlichen Schlüssel
 * (Organisation, Anbieter, Region, externes Konto) statt an die Zeilen-ID: Die ID vergibt die DB erst
 * beim Einfügen, und beim erneuten Verbinden landet der Token per Upsert auf der bestehenden Zeile.
 * Teile dürfen nicht leer sein und keinen `:` enthalten, damit die Bindung eindeutig bleibt.
 */
export function connectionTokenAad(input: ConnectionAadInput): string {
  const region = input.region ?? '-';
  const parts = [input.organizationId, input.provider, region, input.externalAccountId];
  if (input.region === '-' || parts.some((part) => !part || part.includes(':'))) {
    throw new TypeError(
      'connectionTokenAad: Teile dürfen nicht leer sein und keinen Doppelpunkt enthalten.',
    );
  }
  return `connection:${parts.join(':')}`;
}

function requireAad(aad: string): Buffer {
  if (!aad) {
    throw new TypeError('AAD darf nicht leer sein (Ciphertext muss an seinen Ort gebunden sein).');
  }
  return Buffer.from(aad, 'utf8');
}

export function encrypt(
  plaintext: string,
  { keyring, aad }: { keyring: Keyring; aad: string },
): string {
  if (!plaintext) throw new TypeError('Leere Werte werden nicht verschlüsselt.');
  const aadBytes = requireAad(aad);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBytes);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    keyring.current.id,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

interface ParsedCiphertext {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

function parseCiphertext(ciphertext: string): ParsedCiphertext {
  const parts = ciphertext.split(':');
  if (parts.length !== 5) throw new DecryptionError('Unbekanntes Ciphertext-Format.');
  const [version, keyId, ivText, tagText, dataText] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Werte aus dem Ciphertext erst nach Prüfung in Meldungen verwenden (Log-Injection).
  if (version !== VERSION) throw new DecryptionError('Nicht unterstützte Ciphertext-Version.');
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new DecryptionError('Ungültige Schlüssel-ID im Ciphertext.');
  }

  const iv = decodeStrict(ivText, 'base64url');
  const tag = decodeStrict(tagText, 'base64url');
  const data = decodeStrict(dataText, 'base64url');
  if (
    iv === null ||
    tag === null ||
    data === null ||
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES ||
    data.length === 0
  ) {
    throw new DecryptionError('Unbekanntes Ciphertext-Format.');
  }
  return { keyId, iv, tag, data };
}

export function decrypt(
  ciphertext: string,
  { keyring, aad }: { keyring: Keyring; aad: string },
): string {
  const aadBytes = requireAad(aad);
  const { keyId, iv, tag, data } = parseCiphertext(ciphertext);

  const key = [keyring.current, ...keyring.previous].find((candidate) => candidate.id === keyId);
  if (!key) throw new DecryptionError(`Unbekannte Schlüssel-ID "${keyId}".`);

  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError(
      'Entschlüsselung fehlgeschlagen (falscher Schlüssel, falsche Zuordnung oder manipulierte Daten).',
    );
  }
}

/**
 * Wurde der Wert nicht mit dem aktuellen Schlüssel verschlüsselt? (für das Rotations-Skript)
 * Wirft `DecryptionError` bei kaputten Werten: Das Skript soll solche Zeilen melden und überspringen.
 */
export function needsReencryption(ciphertext: string, keyring: Keyring): boolean {
  return ciphertextKeyId(ciphertext) !== keyring.current.id;
}

/** Geprüfte Schlüssel-ID eines Ciphertexts (z. B. fürs Audit der Rotation). Wirft `DecryptionError`. */
export function ciphertextKeyId(ciphertext: string): string {
  return parseCiphertext(ciphertext).keyId;
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Verschlüsselung für Secrets in der Datenbank (z. B. Amazon-Refresh-Tokens). Nur Server
 * (`@profitbash/shared/crypto`, nutzt `node:crypto`).
 *
 * Format: `v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url), AES-256-GCM.
 * - `keyId` erlaubt Schlüsselrotation: Neue Werte nutzen den aktuellen Schlüssel, alte werden mit
 *   den vorherigen Schlüsseln entschlüsselt und können neu verschlüsselt werden.
 * - Die AAD bindet den Ciphertext an seinen Ort (z. B. Organisation + Connection). Ein kopierter Wert
 *   lässt sich an keiner anderen Stelle entschlüsseln.
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

/** Entschlüsseln fehlgeschlagen. Meldungen enthalten nie Klartext oder Schlüssel. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function parseKey(id: string, base64Key: string, source: string): EncryptionKey {
  if (!KEY_ID_PATTERN.test(id)) {
    throw new KeyringError(
      `${source}: ungültige Schlüssel-ID (erlaubt: A-Z, a-z, 0-9, _ und -, höchstens 32 Zeichen).`,
    );
  }
  const key = Buffer.from(base64Key.trim(), 'base64');
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

/** AAD für den Refresh-Token einer Connection. IDs ohne `:`, damit die Bindung eindeutig bleibt. */
export function connectionTokenAad(organizationId: string, connectionId: string): string {
  for (const id of [organizationId, connectionId]) {
    if (!id || id.includes(':')) {
      throw new Error('AAD-IDs dürfen nicht leer sein und keinen Doppelpunkt enthalten.');
    }
  }
  return `connection:${organizationId}:${connectionId}`;
}

function requireAad(aad: string): Buffer {
  if (!aad)
    throw new Error('AAD darf nicht leer sein (Ciphertext muss an seinen Ort gebunden sein).');
  return Buffer.from(aad, 'utf8');
}

export function encrypt(
  plaintext: string,
  { keyring, aad }: { keyring: Keyring; aad: string },
): string {
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
  const [version, keyId, iv, tag, data] = parts as [string, string, string, string, string];
  if (version !== VERSION) {
    throw new DecryptionError(`Nicht unterstützte Ciphertext-Version "${version}".`);
  }
  const parsed = {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    data: Buffer.from(data, 'base64url'),
  };
  if (parsed.iv.length !== IV_BYTES || parsed.tag.length !== TAG_BYTES) {
    throw new DecryptionError('Unbekanntes Ciphertext-Format.');
  }
  return parsed;
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

/** Wurde der Wert nicht mit dem aktuellen Schlüssel verschlüsselt? (für das Rotations-Skript) */
export function needsReencryption(ciphertext: string, keyring: Keyring): boolean {
  return parseCiphertext(ciphertext).keyId !== keyring.current.id;
}

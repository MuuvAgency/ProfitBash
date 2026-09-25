import { describe, expect, it } from 'vitest';
import {
  connectionTokenAad,
  decrypt,
  DecryptionError,
  encrypt,
  KeyringError,
  needsReencryption,
  parseKeyring,
  type Keyring,
} from './crypto';

// Hand-gebaute Testschlüssel (32 Byte, base64), unabhängig vom Code unter Test.
const KEY_A = Buffer.alloc(32, 0xa1).toString('base64');
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64');

const keyringA: Keyring = parseKeyring({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' });
const connection = {
  organizationId: 'org-1',
  provider: 'amazon_ads',
  region: 'eu',
  externalAccountId: 'amzn1.account.A',
} as const;
const aad = connectionTokenAad(connection);

describe('connectionTokenAad', () => {
  // Fängt: falsches oder vertauschtes Bindungsformat → Ciphertexte wären nicht mehr zuordenbar.
  // Gebunden wird an den natürlichen Schlüssel der Connection (vor dem Einfügen bekannt, stabil beim Upsert).
  it('bindet Organisation, Anbieter, Region und externes Konto in festem Format', () => {
    expect(connectionTokenAad(connection)).toBe('connection:org-1:amazon_ads:eu:amzn1.account.A');
    expect(connectionTokenAad({ ...connection, region: null })).toBe(
      'connection:org-1:amazon_ads:-:amzn1.account.A',
    );
  });

  // Fängt: mehrdeutige Bindung (z. B. Org „a:b“ + … = Org „a“ + …) und vergessene Felder.
  it('lehnt leere Teile und Teile mit Doppelpunkt als Programmierfehler ab', () => {
    expect(() => connectionTokenAad({ ...connection, organizationId: 'a:b' })).toThrow(TypeError);
    expect(() => connectionTokenAad({ ...connection, externalAccountId: 'x:y' })).toThrow(
      TypeError,
    );
    expect(() => connectionTokenAad({ ...connection, organizationId: '' })).toThrow(TypeError);
    expect(() => connectionTokenAad({ ...connection, externalAccountId: '' })).toThrow(TypeError);
    expect(() => connectionTokenAad({ ...connection, region: '-' })).toThrow(TypeError);
  });
});

describe('encrypt / decrypt', () => {
  // Fängt: kaputte Ver-/Entschlüsselung, Kodierungsfehler bei Nicht-ASCII.
  it('liefert nach dem Entschlüsseln den Originaltext zurück', () => {
    const plaintext = 'Atzr|IwEBIRefresh-Token-äöü-€';
    const ciphertext = encrypt(plaintext, { keyring: keyringA, aad });
    expect(decrypt(ciphertext, { keyring: keyringA, aad })).toBe(plaintext);
  });

  // Fängt: feste oder wiederverwendete IV (bei GCM ein schwerer Sicherheitsfehler).
  it('erzeugt für denselben Text jedes Mal einen anderen Ciphertext', () => {
    const first = encrypt('gleicher-token', { keyring: keyringA, aad });
    const second = encrypt('gleicher-token', { keyring: keyringA, aad });
    expect(first).not.toBe(second);
  });

  // Fängt: Klartext im Ciphertext, fehlende Schlüssel-ID/Version im Format.
  it('schreibt Version und Schlüssel-ID in den Ciphertext, aber nie den Klartext', () => {
    const ciphertext = encrypt('geheimer-token', { keyring: keyringA, aad });
    expect(ciphertext.startsWith('v1:k1:')).toBe(true);
    expect(ciphertext.split(':')).toHaveLength(5);
    expect(ciphertext).not.toContain('geheimer-token');
  });

  // Fängt: Entschlüsseln mit falschem Schlüssel wird nicht erkannt.
  it('scheitert mit einem anderen Schlüssel derselben ID', () => {
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    const otherKeyring = parseKeyring({ ENCRYPTION_KEY: KEY_B, ENCRYPTION_KEY_ID: 'k1' });
    expect(() => decrypt(ciphertext, { keyring: otherKeyring, aad })).toThrow(DecryptionError);
  });

  // Fängt: fehlende Integritätsprüfung (GCM-Tag nicht ausgewertet).
  it('erkennt manipulierten Ciphertext und manipulierten Auth-Tag', () => {
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    const [version, keyId, iv, tag, cipher] = ciphertext.split(':') as [
      string,
      string,
      string,
      string,
      string,
    ];
    const flip = (value: string) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1); // erstes Zeichen ändern
    const tamperedCipher = [version, keyId, iv, tag, flip(cipher)].join(':');
    const tamperedTag = [version, keyId, iv, flip(tag), cipher].join(':');

    expect(() => decrypt(tamperedCipher, { keyring: keyringA, aad })).toThrow(DecryptionError);
    expect(() => decrypt(tamperedTag, { keyring: keyringA, aad })).toThrow(DecryptionError);
  });

  // Fängt: AAD wird nicht verwendet → Token ließe sich in eine fremde Zeile/Org kopieren.
  it('scheitert, wenn der Ciphertext zu einer anderen Connection gehört', () => {
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    const otherAad = connectionTokenAad({ ...connection, externalAccountId: 'amzn1.account.B' });
    expect(() => decrypt(ciphertext, { keyring: keyringA, aad: otherAad })).toThrow(
      DecryptionError,
    );
  });

  // Fängt: versehentlich vergessene Bindung (leere AAD würde still „funktionieren").
  it('verlangt eine nicht leere AAD beim Ver- und Entschlüsseln', () => {
    expect(() => encrypt('token', { keyring: keyringA, aad: '' })).toThrow(TypeError);
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    expect(() => decrypt(ciphertext, { keyring: keyringA, aad: '' })).toThrow(TypeError);
  });

  // Fängt: unbekannte Schlüssel-IDs werden mit dem aktuellen Schlüssel „probiert“ oder stürzen unklar ab.
  it('meldet eine unbekannte Schlüssel-ID als DecryptionError', () => {
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    const unknownKey = ciphertext.replace('v1:k1:', 'v1:k9:');
    expect(() => decrypt(unknownKey, { keyring: keyringA, aad })).toThrow(/k9/);
    expect(() => decrypt(unknownKey, { keyring: keyringA, aad })).toThrow(DecryptionError);
  });

  // Fängt: fehlende Formatprüfung (falsche Version, Müll, fehlende Teile).
  it('lehnt unbekannte Versionen und kaputte Formate ab', () => {
    const ciphertext = encrypt('token', { keyring: keyringA, aad });
    for (const bad of [
      ciphertext.replace(/^v1:/, 'v2:'),
      'kein-ciphertext',
      'v1:k1:nur-drei-teile',
      '',
    ]) {
      expect(() => decrypt(bad, { keyring: keyringA, aad })).toThrow(DecryptionError);
    }
  });
});

describe('Robustheit gegen manipulierte oder kaputte Eingaben', () => {
  const parts = () =>
    encrypt('token', { keyring: keyringA, aad }).split(':') as [
      string,
      string,
      string,
      string,
      string,
    ];

  // Fängt: fehlende Tag-Längenprüfung → GCM-Truncation-Angriff (Node akzeptiert kurze Tags sonst).
  it('lehnt einen abgeschnittenen Auth-Tag ab', () => {
    const [version, keyId, iv, tag, cipher] = parts();
    const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(() =>
      decrypt([version, keyId, iv, shortTag, cipher].join(':'), { keyring: keyringA, aad }),
    ).toThrow(DecryptionError);
  });

  // Fängt: nachsichtiges Base64-Decoding → mehrere Strings ergeben denselben Wert.
  it('lehnt Zeichen außerhalb von base64url im Ciphertext ab', () => {
    const [version, keyId, iv, tag, cipher] = parts();
    expect(() =>
      decrypt([version, keyId, iv, tag, `${cipher}!`].join(':'), { keyring: keyringA, aad }),
    ).toThrow(DecryptionError);
  });

  // Fängt: ungeprüfte Werte aus dem Ciphertext in Fehlermeldungen (Log-Injection).
  it('übernimmt keine ungeprüften Werte aus dem Ciphertext in Fehlermeldungen', () => {
    const [version, , iv, tag, cipher] = parts();
    const injected = [version, 'k1\nFAKE LOG LINE', iv, tag, cipher].join(':');
    let error: unknown;
    try {
      decrypt(injected, { keyring: keyringA, aad });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DecryptionError);
    expect((error as Error).message).not.toContain('FAKE LOG LINE');
    expect((error as Error).message).not.toContain('\n');
  });

  // Fängt: leere Tokens werden durch einen Fehler weiter oben still gespeichert.
  it('verschlüsselt keinen leeren Text', () => {
    expect(() => encrypt('', { keyring: keyringA, aad })).toThrow(TypeError);
  });
});

describe('Schlüsselrotation', () => {
  const rotated = parseKeyring({
    ENCRYPTION_KEY: KEY_B,
    ENCRYPTION_KEY_ID: 'k2',
    ENCRYPTION_KEYS_PREVIOUS: `k1:${KEY_A}`,
  });

  // Fängt: alte Schlüssel werden nach der Rotation nicht mehr zum Entschlüsseln genutzt.
  it('entschlüsselt alte Ciphertexte mit dem vorherigen Schlüssel', () => {
    const oldCiphertext = encrypt('alter-token', { keyring: keyringA, aad });
    expect(decrypt(oldCiphertext, { keyring: rotated, aad })).toBe('alter-token');
  });

  // Fängt: nach der Rotation wird weiter mit dem alten Schlüssel verschlüsselt.
  it('verschlüsselt neue Werte immer mit dem aktuellen Schlüssel', () => {
    expect(encrypt('neu', { keyring: rotated, aad }).startsWith('v1:k2:')).toBe(true);
  });

  // Fängt: das Rotations-Skript erkennt nicht, welche Werte neu verschlüsselt werden müssen.
  it('erkennt Ciphertexte, die neu verschlüsselt werden sollten', () => {
    const oldCiphertext = encrypt('alt', { keyring: keyringA, aad });
    const newCiphertext = encrypt('neu', { keyring: rotated, aad });
    expect(needsReencryption(oldCiphertext, rotated)).toBe(true);
    expect(needsReencryption(newCiphertext, rotated)).toBe(false);
  });

  // Fängt: das Rotations-Skript bekommt bei kaputten Werten still ein falsches Ergebnis.
  it('meldet kaputte Werte bei der Rotationsprüfung als DecryptionError', () => {
    expect(() => needsReencryption('kein-ciphertext', rotated)).toThrow(DecryptionError);
  });
});

describe('parseKeyring', () => {
  // Fängt: nachsichtiges Base64 → ein falsch eingefügter Wert wird still als Schlüssel akzeptiert.
  it('akzeptiert nur sauberes Base64 als Schlüssel', () => {
    const withJunk = `${KEY_A.slice(0, 10)}!${KEY_A.slice(10)}`;
    expect(() => parseKeyring({ ENCRYPTION_KEY: withJunk, ENCRYPTION_KEY_ID: 'k1' })).toThrow(
      KeyringError,
    );
  });

  // Fängt: ungeprüfte Schlüssellänge (z. B. 16 statt 32 Byte → AES-128 oder Absturz später).
  it('verlangt genau 32 Byte Schlüssellänge', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() => parseKeyring({ ENCRYPTION_KEY: shortKey, ENCRYPTION_KEY_ID: 'k1' })).toThrow(
      KeyringError,
    );
  });

  // Fängt: Schlüssel-IDs mit ":" würden das Ciphertext-Format zerbrechen.
  it('erlaubt nur einfache Schlüssel-IDs', () => {
    expect(() => parseKeyring({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k:1' })).toThrow(
      KeyringError,
    );
    expect(() => parseKeyring({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: '' })).toThrow(
      KeyringError,
    );
  });

  // Fängt: doppelte IDs → Entschlüsseln mit dem falschen Schlüssel.
  it('lehnt doppelte Schlüssel-IDs ab', () => {
    expect(() =>
      parseKeyring({
        ENCRYPTION_KEY: KEY_A,
        ENCRYPTION_KEY_ID: 'k1',
        ENCRYPTION_KEYS_PREVIOUS: `k1:${KEY_B}`,
      }),
    ).toThrow(KeyringError);
  });

  // Fängt: kaputte Rotationsliste wird still ignoriert.
  it('lehnt eine fehlerhafte Liste vorheriger Schlüssel ab', () => {
    expect(() =>
      parseKeyring({
        ENCRYPTION_KEY: KEY_B,
        ENCRYPTION_KEY_ID: 'k2',
        ENCRYPTION_KEYS_PREVIOUS: 'k1-ohne-doppelpunkt',
      }),
    ).toThrow(KeyringError);
  });

  // Fängt: Schlüsselmaterial in Fehlermeldungen (landet sonst in Logs).
  it('nennt in Fehlermeldungen nie den Schlüssel selbst', () => {
    const shortKey = Buffer.alloc(16, 7).toString('base64');
    let error: unknown;
    try {
      parseKeyring({ ENCRYPTION_KEY: shortKey, ENCRYPTION_KEY_ID: 'k1' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KeyringError);
    expect((error as Error).message).not.toContain(shortKey);
  });

  // Fängt: leerer Rotations-Eintrag (typisch: leere Env-Variable) wird als Fehler behandelt.
  it('akzeptiert eine leere Liste vorheriger Schlüssel', () => {
    const keyring = parseKeyring({
      ENCRYPTION_KEY: KEY_A,
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEYS_PREVIOUS: '',
    });
    expect(decrypt(encrypt('x', { keyring, aad }), { keyring, aad })).toBe('x');
  });
});

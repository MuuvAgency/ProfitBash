import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  memberCreateSchema,
  memberPatchSchema,
  passwordLinkRedeemSchema,
  passwordLinkTokenSchema,
} from './members';

describe('Mitglieder (F9)', () => {
  it('Anlegen: E-Mail klein und getrimmt, Name, Rolle', () => {
    expect(
      memberCreateSchema.parse({ email: ' Emil@Muuv.TEST ', name: ' Emil ', role: 'editor' }),
    ).toEqual({ email: 'emil@muuv.test', name: 'Emil', role: 'editor' });
    expect(memberCreateSchema.safeParse({ email: 'kein', name: 'x', role: 'editor' }).success).toBe(
      false,
    );
    expect(
      memberCreateSchema.safeParse({ email: 'a@b.de', name: '', role: 'editor' }).success,
    ).toBe(false);
    expect(
      memberCreateSchema.safeParse({ email: 'a@b.de', name: 'A', role: 'owner' }).success,
    ).toBe(false);
  });

  it('Rolle ändern', () => {
    expect(memberPatchSchema.parse({ role: 'viewer' })).toEqual({ role: 'viewer' });
    expect(memberPatchSchema.safeParse({}).success).toBe(false);
  });

  it('Token: 43 Zeichen base64url (32 Byte), Passwort mindestens 12 Zeichen', () => {
    const token = 'a'.repeat(43);
    expect(passwordLinkTokenSchema.safeParse({ token }).success).toBe(true);
    expect(passwordLinkTokenSchema.safeParse({ token: 'a'.repeat(42) }).success).toBe(false);
    expect(passwordLinkTokenSchema.safeParse({ token: `${'a'.repeat(42)}/` }).success).toBe(false);
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordLinkRedeemSchema.safeParse({ token, password: 'x'.repeat(11) }).success).toBe(
      false,
    );
    expect(passwordLinkRedeemSchema.safeParse({ token, password: 'x'.repeat(12) }).success).toBe(
      true,
    );
  });
});

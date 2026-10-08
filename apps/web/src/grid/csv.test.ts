import { describe, expect, it } from 'vitest';
import { fileNamePart } from './csv';

describe('fileNamePart', () => {
  it('macht aus freiem Text einen Teil eines Dateinamens', () => {
    expect(fileNamePart('Demo DE')).toBe('demo-de');
    expect(fileNamePart('  Müller & Söhne GmbH / UK ')).toBe('muller-sohne-gmbh-uk');
    expect(fileNamePart('../..\\x:y')).toBe('x-y');
  });
});

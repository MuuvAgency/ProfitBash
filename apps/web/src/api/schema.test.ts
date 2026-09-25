import { readFile } from 'node:fs/promises';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

// @vitest-environment node

const openapiFile = new URL('../../../api/openapi.json', import.meta.url);
const generatedFile = new URL('./schema.gen.ts', import.meta.url);

describe('schema.gen.ts', () => {
  it('ist aus dem aktuellen openapi.json erzeugt (sonst `pnpm api:generate` ausführen)', async () => {
    const expected = `${COMMENT_HEADER}${astToString(await openapiTS(openapiFile))}`;
    expect(await readFile(generatedFile, 'utf8')).toBe(expected);
  });
});

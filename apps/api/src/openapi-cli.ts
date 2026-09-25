import { writeFile } from 'node:fs/promises';
import { OPENAPI_FILE, renderOpenApiDocument } from './openapi';

await writeFile(OPENAPI_FILE, await renderOpenApiDocument());
console.log(`OpenAPI-Dokument geschrieben: ${OPENAPI_FILE}`);

import type { FileImporters } from '../jobs/file-import';
import { importBulkFile } from './bulk';

/**
 * Importer je Dateiart (`phase-1.md` 1.11d Bulk-Datei, 1.11e Tagesbericht). Solange einer fehlt, endet der
 * Import dieser Dateiart mit „noch nicht unterstützt“.
 */
export const FILE_IMPORTERS: FileImporters = { bulk: importBulkFile };

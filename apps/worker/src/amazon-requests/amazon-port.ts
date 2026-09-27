import {
  AmazonAdsDuplicateReportError,
  createExportRowSchema,
  createReportRowSchema,
  EXPORT_TYPES,
  isReportType,
  type AmazonAdsClient,
  type AmazonAdsExportType,
  type AmazonAdsReportType,
  type ConnectionRef,
  type RequestMeter,
} from '@profitbash/amazon-ads';
import type { AmazonRequest } from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import type { AmazonRequestPort, AmazonRequestSubmission } from './state-machine';

/**
 * Echte Schnittstelle der Zustandsmaschine (1.4) zu Amazon, je Connection und Lauf (Phase 1, 1.6).
 * Reports über Reporting v3, Exports über die Exports-API; Status, Downloads und Zeilen-Schemas kommen aus
 * `@profitbash/amazon-ads` im eigenen Modell. Das Schreiben (`import`) liefert der Aufrufer (1.7), weil es die
 * Zeilen auf die DB-Typen abbildet.
 */
export interface AmazonRequestPortOptions {
  client: AmazonAdsClient;
  connection: ConnectionRef;
  /** Interne Profil-ID → Amazon-Profil-ID, für alle Profile der Connection. */
  amazonProfileIds: ReadonlyMap<string, string>;
  /** Zähler des laufenden Jobs (`ConnectionJobRun`). */
  meter?: RequestMeter;
  logger: Logger;
  import: AmazonRequestPort['import'];
}

export function createAmazonRequestPort(options: AmazonRequestPortOptions): AmazonRequestPort {
  const { client, connection } = options;
  const requestOptions = options.meter ? { meter: options.meter } : {};

  function amazonProfileId(request: AmazonRequest): string {
    const id = options.amazonProfileIds.get(request.profileId);
    if (id === undefined) throw new Error('Profil gehört nicht zur Connection des Laufs.');
    return id;
  }

  function amazonRequestId(request: AmazonRequest): string {
    if (request.amazonRequestId === null) throw new Error('Auftrag hat noch keine ID von Amazon.');
    return request.amazonRequestId;
  }

  function reportType(request: AmazonRequest): AmazonAdsReportType {
    if (!isReportType(request.reportType)) {
      throw new Error(`Report-Typ ${request.reportType} ist nicht im Katalog.`);
    }
    return request.reportType;
  }

  function exportType(request: AmazonRequest): AmazonAdsExportType {
    const type = EXPORT_TYPES.find((candidate) => candidate === request.reportType);
    if (type === undefined) throw new Error(`Export-Typ ${request.reportType} ist unbekannt.`);
    return type;
  }

  return {
    async request(request): Promise<AmazonRequestSubmission> {
      const profileId = amazonProfileId(request);
      if (request.kind === 'export') {
        const { exportId } = await client.requestExport(
          connection,
          {
            amazonProfileId: profileId,
            exportType: exportType(request),
            adProduct: request.adProduct,
          },
          requestOptions,
        );
        return { status: 'requested', amazonRequestId: exportId };
      }
      const type = reportType(request);
      if (request.startDate === null || request.endDate === null) {
        throw new Error('Report-Auftrag ohne Zeitraum.');
      }
      try {
        const { reportId } = await client.requestReport(
          connection,
          {
            amazonProfileId: profileId,
            reportType: type,
            startDate: request.startDate,
            endDate: request.endDate,
          },
          requestOptions,
        );
        return { status: 'requested', amazonRequestId: reportId };
      } catch (error) {
        if (error instanceof AmazonAdsDuplicateReportError) {
          return { status: 'duplicate', amazonRequestId: error.duplicateOfReportId };
        }
        throw error;
      }
    },

    async getStatus(request) {
      const ref = { amazonProfileId: amazonProfileId(request) };
      return request.kind === 'export'
        ? client.getExport(
            connection,
            { ...ref, exportType: exportType(request), exportId: amazonRequestId(request) },
            requestOptions,
          )
        : client.getReport(
            connection,
            { ...ref, reportId: amazonRequestId(request) },
            requestOptions,
          );
    },

    download: (_request, url) => client.downloadFile(url),

    rowSchema(request) {
      return request.kind === 'export'
        ? createExportRowSchema(exportType(request), {
            adProduct: request.adProduct,
            logger: options.logger,
          })
        : createReportRowSchema(reportType(request));
    },

    import: options.import,
  };
}

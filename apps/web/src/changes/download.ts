/** Lädt einen Blob als Datei herunter (Bulk-Datei einer Übermittlung). */
export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Später freigeben: Manche Browser brechen den Download sonst ab.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

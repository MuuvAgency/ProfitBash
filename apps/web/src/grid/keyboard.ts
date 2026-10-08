/**
 * Tastatur (2.13): Zellen sind fokussierbar (Pfeiltasten). Enter auf einer Zelle mit Link oder Knopf (Name mit
 * Drill-Down, „teilt sich n ASINs“, Sprung in den Explorer) löst ihn aus; ist das Element selbst fokussiert, handelt es
 * ohnehin selbst.
 */
export function activateCellControlOnEnter(event: Event | null | undefined) {
  if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return;
  // Gehaltenes Enter klickte wiederholt (Popover flackert, Route doppelt); Modifikatoren bleiben dem Browser.
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const cell = event.target;
  if (!(cell instanceof HTMLElement) || !cell.classList.contains('ag-cell')) return;
  const control = cell.querySelector<HTMLElement>('a[href], button');
  if (!control) return;
  event.preventDefault();
  control.click();
}

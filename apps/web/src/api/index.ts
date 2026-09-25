import { createApi } from './client';

export { ApiError } from './errors';
export type { Api, SignInInput } from './client';

const unauthorizedListeners = new Set<() => void>();

/** API-Client der App. 401 eigener Endpunkte wird an `onUnauthorized` gemeldet. */
export const api = createApi({
  onUnauthorized: () => unauthorizedListeners.forEach((listener) => listener()),
});

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

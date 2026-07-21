/**
 * Same-origin API client for the littlebird-voice Worker (`/api/*`).
 *
 * - Bearer token: stored in localStorage under `lb.apiToken`; pasted once by
 *   the user (Settings). `onApiTokenChange` lets the sync layer drain its
 *   outbox the moment a token is set/changed.
 * - Error normalization: every non-2xx response is expected to follow the
 *   canonical `{ error: { code, message } }` schema; `apiFetch` throws an
 *   `ApiError` carrying `status` + `code` + a readable message.
 */

const TOKEN_KEY = "lb.apiToken";
const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

/** Read the stored API token (null when unset/unavailable). */
export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the API token and notify subscribers. */
export function setApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode etc.) — listeners still fire */
  }
  for (const cb of tokenListeners) {
    try {
      cb(token);
    } catch {
      /* one bad listener must not break the rest */
    }
  }
}

/**
 * Subscribe to token set/change/clear events (used as an outbox drain
 * trigger). Returns an unsubscribe function.
 */
export function onApiTokenChange(cb: TokenListener): () => void {
  tokenListeners.add(cb);
  return () => tokenListeners.delete(cb);
}

/**
 * Fetch `/api<path>` with the bearer header attached. Returns the parsed JSON
 * body for 2xx (or `undefined` for 204/empty). Throws `ApiError` on non-2xx,
 * normalizing the canonical error schema.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getApiToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep defaults */
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

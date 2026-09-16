// Tekion APC client: token exchange + cache, versioned GET/POST/PUT with dealer headers,
// one automatic retry on 401 (token expired), typed errors. No credentials are ever logged.

const env = process.env;
export const TEKION_BASE = env.TEKION_BASE || "https://api-sandbox.tekioncloud.com/openapi";
const APP_ID = env.TEKION_APP_ID;
const SECRET = env.TEKION_SECRET_KEY;
const DEALER_ID = env.TEKION_DEALER_ID;

let tokenCache = { token: null, expiresAt: 0 };
let tokenInFlight = null;

export function resetToken() { tokenCache = { token: null, expiresAt: 0 }; }
export function tokenState() { return { cached: Boolean(tokenCache.token), expiresAt: tokenCache.expiresAt }; }

export async function getToken() {
  if (tokenCache.token && tokenCache.expiresAt - Date.now() > 10 * 60 * 1000) return tokenCache.token;
  if (tokenInFlight) return tokenInFlight; // coalesce so we never burn the 20-per-15-minute limit
tokenInFlight = (async () => {
  const res = await fetch(`${TEKION_BASE}/public/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ app_id: APP_ID, secret_key: SECRET }),
  });
  const text = await res.text();
  if (!res.ok) throw new TekionError(`token ${res.status}`, res.status, text);
  const json = JSON.parse(text);
  const d = json.data ?? json;
  const token = d.access_token ?? d.accessToken ?? d.token ?? d.bearerToken;
  if (!token) throw new Error(`token response had no token field: ${Object.keys(d).join(",")}`);
  let expiresAt = Number(d.expire_on ?? d.expires_at ?? d.expiresAt ?? d.expiry ?? 0);
  if (expiresAt && expiresAt < 1e12) expiresAt *= 1000;
  if (!expiresAt || expiresAt < Date.now()) expiresAt = Date.now() + 23 * 3600 * 1000;
  tokenCache = { token, expiresAt };
  return token;
})();
  try { return await tokenInFlight; } finally { tokenInFlight = null; }
}

export class TekionError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body ?? "").slice(0, 400);
  }
}

async function request(method, version, path, body, { retryOn401 = true } = {}) {
  const token = await getToken();
  const res = await fetch(`${TEKION_BASE}/${version}${path}`, {
    method,
    headers: { "Content-Type": "application/json", app_id: APP_ID, Authorization: `Bearer ${token}`, dealer_id: DEALER_ID },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retryOn401) { resetToken(); return request(method, version, path, body, { retryOn401: false }); }
  const text = await res.text();
  if (!res.ok) throw new TekionError(`tekion ${res.status} ${method} ${version}${path.split("?")[0]}`, res.status, text);
  return text ? JSON.parse(text) : {};
}

export const tekion = {
  get: (path, version = "v3.1.0") => request("GET", version, path),
  post: (path, body, version = "v3.1.0") => request("POST", version, path, body),
  put: (path, body, version = "v3.1.0") => request("PUT", version, path, body),
};

// Walk a paginated Tekion GET (meta.nextFetchKey) and concatenate data[].
export async function getAllPages(path, { version = "v3.1.0", maxPages = 20 } = {}) {
  const out = [];
  let nextFetchKey = null, pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await tekion.get(nextFetchKey ? `${path}${sep}nextFetchKey=${encodeURIComponent(nextFetchKey)}` : path, version);
    out.push(...(r?.data ?? []));
    nextFetchKey = r?.meta?.nextFetchKey || null;
    pages++;
  } while (nextFetchKey && pages < maxPages);
  return out;
}

export const dealerId = DEALER_ID;

/**
 * dsh-balance host half.
 *
 * Owns the DeepSeek API-key balance read and exposes it to the browser half over
 * one authenticated Fetch route (`/api/dsh-balance.balance`). The key never
 * reaches the page:
 *
 *   1. the DSH credential store (`ctx.credentials.resolve('DEEPSEEK_API_KEY')`,
 *      i.e. what the Models page / settings saved), then
 *   2. the launching environment (`DEEPSEEK_API_KEY`).
 *
 * Upstream is the official `GET https://api.deepseek.com/user/balance`.
 */
const BALANCE_ROUTE = "/api/dsh-balance.balance";
const UPSTREAM = "https://api.deepseek.com/user/balance";
/** Collapse bursts from several tabs/refreshes into one upstream call. */
const CACHE_MS = 3000;
const TIMEOUT_MS = 10000;
const CREDENTIAL_REF = "DEEPSEEK_API_KEY";

export const name = "dsh-balance";
export const inject = ["connection"];

/**
 * Resolve the API key: DSH credential store first, launching environment second.
 * @param ctx - Host context carrying the optional credentials service.
 * @returns the key and the layer that supplied it, or undefined when neither is configured.
 */
async function resolveKey(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined && typeof credentials.resolve === "function") {
    try {
      const hit = await credentials.resolve(CREDENTIAL_REF);
      if (hit !== undefined && typeof hit.value === "string" && hit.value.trim().length > 0) {
        return { key: hit.value.trim(), source: hit.source ?? "credentials" };
      }
    } catch {
      // A broken credential store must not mask the environment fallback.
    }
  }
  const ambient = process.env[CREDENTIAL_REF];
  if (typeof ambient === "string" && ambient.trim().length > 0) return { key: ambient.trim(), source: "env" };
  return undefined;
}

/** One wallet row from `balance_infos`. */
function walletOf(info) {
  if (info === null || typeof info !== "object" || typeof info.currency !== "string") return undefined;
  const text = value => (typeof value === "string" ? value : null);
  return {
    currency: info.currency,
    total: text(info.total_balance),
    granted: text(info.granted_balance),
    toppedUp: text(info.topped_up_balance),
  };
}

/**
 * Read the upstream balance once.
 * @param ctx - Host context used to resolve the key.
 * @returns the wire body served to the browser half; never carries the key.
 */
async function readBalance(ctx) {
  const resolved = await resolveKey(ctx);
  if (resolved === undefined) {
    return { ok: false, error: `未配置 DeepSeek API 密钥（凭据存储或 ${CREDENTIAL_REF} 环境变量）` };
  }
  let response;
  try {
    response = await fetch(UPSTREAM, {
      method: "GET",
      headers: { authorization: `Bearer ${resolved.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, error: timeout ? "余额查询超时" : "余额查询失败（网络错误）" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: "API 密钥无效或已过期" };
  if (!response.ok) return { ok: false, error: `余额接口返回 HTTP ${response.status}` };
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "余额接口返回的数据无法解析" };
  }
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const wallets = infos.map(walletOf).filter(wallet => wallet !== undefined);
  if (wallets.length === 0) return { ok: false, error: "余额接口未返回可用钱包" };
  return {
    ok: true,
    available: payload?.is_available === true,
    wallets,
    source: resolved.source,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Register the balance route.
 * @param ctx - Host context carrying the connection fetch registry.
 */
export function apply(ctx) {
  let cache;
  const cachedBalance = async () => {
    const now = Date.now();
    if (cache !== undefined && now - cache.at < CACHE_MS) return cache.body;
    const body = await readBalance(ctx);
    if (body.ok) cache = { at: now, body };
    return body;
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: BALANCE_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => new Response(JSON.stringify(await cachedBalance()), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  }), "dsh-balance: balance route");
}

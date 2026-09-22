// 抓取层:超时 / 重试 / UA / 方法 / 请求体 / Cookie 会话 / 失败不崩
// 只用 Node 内置能力,零依赖。

export class FetchError extends Error {
  constructor(msg, { url, status } = {}) {
    super(msg);
    this.name = "FetchError";
    this.url = url;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ============================ Cookie 会话 ============================ */
/** 极简 cookie jar:支撑登录流程(把上一步的 Set-Cookie 自动带到后续请求) */
export class CookieJar {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  absorb(setCookies) {
    for (const raw of setCookies ?? []) {
      const first = String(raw).split(";")[0];
      const i = first.indexOf("=");
      if (i > 0) this.map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
    return this;
  }
  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
  get size() { return this.map.size; }
  toObject() { return Object.fromEntries(this.map); }
}

/* ============================ 请求 ============================ */
/**
 * 发一个请求,返回结构化结果(带响应头与 Set-Cookie)
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:any,
 *          bodyType?:'form'|'json'|'raw', timeoutMs?:number, retries?:number,
 *          jar?:CookieJar, redirect?:'follow'|'manual'}} opts
 */
export async function request(url, opts = {}) {
  const { method = "GET", headers = {}, body, bodyType = "form", timeoutMs = 15000, retries = 2, jar, redirect = "follow" } = opts;

  const h = { "user-agent": DEFAULT_UA, accept: "*/*", ...headers };
  let payload;
  if (body != null && method !== "GET" && method !== "HEAD") {
    if (bodyType === "json") { payload = typeof body === "string" ? body : JSON.stringify(body); h["content-type"] ??= "application/json"; }
    else if (bodyType === "form") { payload = new URLSearchParams(body).toString(); h["content-type"] ??= "application/x-www-form-urlencoded"; }
    else { payload = String(body); }
  }
  if (jar && jar.size) h.cookie = h.cookie ? `${h.cookie}; ${jar.header()}` : jar.header();

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: h, body: payload, signal: ac.signal, redirect });
      clearTimeout(timer);
      const text = await res.text();
      const setCookies = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
      if (jar) jar.absorb(setCookies);
      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastErr = new FetchError(`HTTP ${res.status}`, { url, status: res.status });
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { status: res.status, ok: res.ok, text, headers: Object.fromEntries(res.headers.entries()), setCookies, finalUrl: res.url || url };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? new FetchError(`请求超时(${timeoutMs}ms)`, { url }) : e;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** 兼容旧接口:只要文本(非 2xx 抛错) */
export async function getText(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) throw new FetchError(`HTTP ${r.status}`, { url, status: r.status });
  return r.text;
}

export async function getJson(url, opts) {
  const text = await getText(url, opts);
  try { return JSON.parse(text); }
  catch { throw new FetchError("返回内容不是合法 JSON", { url }); }
}

/** 并发受控地跑一批任务(避免把对方站点打挂) */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

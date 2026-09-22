// 采集核心 —— CLI(monitor.mjs)与 API 服务(server.mjs)共用
//
// 支持两种写法:
//   简单:  { url, extract }                                  —— 一个请求搞定
//   多步:  { steps: [ {url,extract,saveAs}, {url,...} ] }     —— 先登录/取 token,再取数据
//          后续步骤可用 {{变量名}} 引用前面 saveAs 存下来的值
import { request, CookieJar } from "./fetch.mjs";
import { extractValue, fingerprint } from "./extract.mjs";
import { append, previous, stats, history } from "./store.mjs";

/* ============================ 告警判定 ============================ */
export function judge(rule, r, st) {
  if (!rule) return null;
  if (rule.changed && r.changed) return `内容已变更 → ${String(r.value).slice(0, 24)}`;
  if (typeof r.value !== "number") return null;
  if (rule.changePct != null && r.deltaPct != null && Math.abs(r.deltaPct) >= rule.changePct)
    return `环比 ${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(2)}%`;
  if (rule.above != null && r.value > rule.above) return `高于阈值 ${rule.above}`;
  if (rule.below != null && r.value < rule.below) return `低于阈值 ${rule.below}`;
  if (rule.z != null && st && st.sd > 0) {
    const z = Math.abs(r.value - st.mean) / st.sd;
    if (z >= rule.z) return `统计异常 ${z.toFixed(1)}σ`;
  }
  return null;
}

export function diffOf(value, prevValue, hasPrev) {
  const out = { value, prevValue: hasPrev ? prevValue : null, delta: null, deltaPct: null, changed: undefined };
  if (typeof value === "number" && typeof prevValue === "number") {
    out.delta = +(value - prevValue).toFixed(4);
    out.deltaPct = prevValue !== 0 ? +(((value - prevValue) / Math.abs(prevValue)) * 100).toFixed(4) : null;
  } else if (hasPrev) {
    out.changed = String(value) !== String(prevValue);
  }
  return out;
}

/* ============================ 多步引擎 ============================ */
/** 把 target 归一化成步骤数组(向后兼容简单的 url+extract 写法) */
export function stepsOf(target) {
  if (Array.isArray(target.steps) && target.steps.length) return target.steps;
  return [{
    url: target.url, extract: target.extract,
    method: target.method, headers: target.headers,
    body: target.body, bodyType: target.bodyType,
  }];
}

/** 用 {{变量}} 替换 —— 支持 URL / 请求头 / 请求体 */
function interpolate(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

/**
 * 执行一个目标的所有步骤,返回最后一步提取到的值
 * @returns {Promise<{value:any, trace:Array}>}
 */
export async function runSteps(target, { jar, timeoutMs } = {}) {
  const steps = stepsOf(target);
  const session = jar ?? new CookieJar(target.cookies ?? {});
  const vars = {};
  const trace = [];
  let value;

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    const step = interpolate(raw, vars);
    const url = step.url;
    if (!url) throw new Error(`第 ${i + 1} 步缺少 url`);

    const res = await request(url, {
      method: step.method ?? "GET",
      headers: step.headers ?? {},
      body: step.body,
      bodyType: step.bodyType ?? "form",
      timeoutMs: step.timeoutMs ?? timeoutMs ?? 15000,
      jar: session,
    });

    const t = {
      step: i + 1, url,
      status: res.status, ok: res.ok,
      bytes: res.text.length,
      cookies: session.size,
      setCookie: res.setCookies.length,
    };

    if (!res.ok) {
      // 非 2xx:默认视为失败(登录失败、被拦截等),但要给出可读信息
      const snippet = res.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      trace.push(t);
      const err = new Error(`第 ${i + 1} 步返回 HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
      err.trace = trace;
      throw err;
    }

    if (raw.extract) {
      value = extractValue(res.text, raw.extract);
      t.extracted = value;
    }
    if (raw.saveAs) { vars[raw.saveAs] = value; t.savedAs = raw.saveAs; }
    trace.push(t);
  }

  return { value, trace };
}

/* ============================ 采集单个目标 ============================ */
export async function collectOne(t, dataDir) {
  const r = {
    id: t.id, label: t.label, unit: t.unit ?? "",
    url: t.url ?? stepsOf(t).at(-1)?.url ?? "",
    extract: t.extract ?? null, rule: t.alert ?? null,
    multiStep: Array.isArray(t.steps) && t.steps.length > 1,
    stepCount: stepsOf(t).length,
  };
  try {
    const { value, trace } = await runSteps(t);
    r.trace = trace;
    const prev = previous(dataDir, t.id);
    Object.assign(r, diffOf(value, prev?.value, !!prev));
    r.alert = judge(t.alert, r, stats(dataDir, t.id));
    append(dataDir, t.id, { ts: Date.now(), value, fp: String(value).slice(0, 200) });
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.error = e.message;
    if (e.trace) r.trace = e.trace;
  }
  const h = history(dataDir, t.id, 30);
  r.spark = h.map((x) => (typeof x.value === "number" ? x.value : null)).filter((v) => v !== null);
  r.historyCount = history(dataDir, t.id).length;
  return r;
}

/** 采集全部目标(顺序执行,天然限流) */
export async function collectAll(config, dataDir, onProgress) {
  const t0 = Date.now();
  const results = [];
  for (const t of config.targets) {
    const r = await collectOne(t, dataDir);
    results.push(r);
    onProgress?.(r, results.length, config.targets.length);
  }
  return { at: Date.now(), title: config.name, results, ms: Date.now() - t0 };
}

/** 不采集,直接从历史快照还原"当前状态" */
export function stateFromHistory(config, dataDir) {
  const results = config.targets.map((t) => {
    const h = history(dataDir, t.id);
    const last = h.length ? h[h.length - 1] : null;
    const prev = h.length > 1 ? h[h.length - 2] : null;
    const r = {
      id: t.id, label: t.label, unit: t.unit ?? "",
      url: t.url ?? stepsOf(t).at(-1)?.url ?? "",
      extract: t.extract ?? null, rule: t.alert ?? null,
      method: t.method ?? "GET",
      headers: t.headers ?? null,
      steps: t.steps ?? null,
      cookies: t.cookies ? Object.keys(t.cookies) : null,
      multiStep: Array.isArray(t.steps) && t.steps.length > 1,
      stepCount: stepsOf(t).length,
      value: last?.value ?? null, ts: last?.ts ?? null,
      historyCount: h.length, ok: true,
    };
    if (last && prev) Object.assign(r, diffOf(last.value, prev.value, true));
    else r.prevValue = null;
    r.alert = last ? judge(t.alert, r, stats(dataDir, t.id)) : null;
    r.spark = h.slice(-30).map((x) => (typeof x.value === "number" ? x.value : null)).filter((v) => v !== null);
    return r;
  });
  return { at: Date.now(), title: config.name, results, ms: 0, fromHistory: true };
}

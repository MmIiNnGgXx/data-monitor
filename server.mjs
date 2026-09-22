#!/usr/bin/env node
// 数据监控台 · 本地服务(零依赖,只用 node:http)
//
// 为什么需要后端:浏览器跑不了 Node 采集 —— 所以"刷新"必须打到服务端真的去采。
//
// 用法:
//   node server.mjs             # 默认 http://127.0.0.1:4210
//   node server.mjs --port=8080
//
// API(全部返回 JSON):
//   GET    /api/state              当前状态(从历史快照还原,不触发采集)
//   POST   /api/run                执行一次全量采集   ← 「刷新」按钮打这个
//   POST   /api/run/:id            只重采某一个目标    ← 表格行上的「重采」
//   GET    /api/history?id=&limit= 单目标历史          ← 「详情」抽屉
//   POST   /api/targets            新增监控目标
//   PUT    /api/targets/:id        修改目标(标签/阈值)
//   DELETE /api/targets/:id        删除目标
//   GET    /api/export.csv         下载 CSV
//   GET    /api/export.json        下载 JSON
//   GET    /api/health             健康检查

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAll, collectOne, stateFromHistory, judge, diffOf } from "./lib/collect.mjs";
import { history, stats, append, ensureDir } from "./lib/store.mjs";
import { getText } from "./lib/fetch.mjs";
import { extractValue } from "./lib/extract.mjs";
import { notify, notifyTest, CHANNEL_TYPES } from "./lib/notify.mjs";
import { writeReports } from "./lib/report.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const argOf = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

// 支持 --config=某配置.json —— 方便切换不同的监控方案(例如跑案例配置)
const CONFIG_PATH = resolve(ROOT, argOf("config") ?? "config.json");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(argOf("port") ?? process.env.PORT ?? 4210);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

/* ---------------- 配置读写 ---------------- */
const loadConfig = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/* ---------------- 运行状态(开发者视角:可观测) ---------------- */
const runtime = {
  startedAt: Date.now(),
  running: false,
  lastRun: null,           // { at, ms, targets, alerts, errors }
  runsTotal: 0,
  lastError: null,
};

/* ---------------- HTTP 辅助 ---------------- */
const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve(null); } });
});
const sendText = (res, text, code = 200, type = "text/plain; charset=utf-8", extra = {}) => {
  res.writeHead(code, { "content-type": type, ...extra });
  res.end(text);
};

/* ---------------- 业务逻辑 ---------------- */
function buildState() {
  const cfg = loadConfig();
  const s = stateFromHistory(cfg, DATA_DIR);
  const alerts = s.results.filter((r) => r.alert).length;
  const errors = s.results.filter((r) => r.error).length;
  const changed = s.results.filter((r) => r.changed === true || (r.delta != null && r.delta !== 0)).length;
  return {
    ...s,
    summary: { targets: s.results.length, changed, alerts, errors },
    runtime: {
      uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
      running: runtime.running, runsTotal: runtime.runsTotal,
      lastRun: runtime.lastRun, lastError: runtime.lastError,
      lastNotify: runtime.lastNotify ?? null,
      notifyConfigured: (loadConfig().notify?.channels ?? []).filter((c) => !c.disabled).length,
    },
  };
}

const EXTRACT_TYPES = ["json", "regex", "length", "text"];

function validateTarget(t) {
  if (!t || typeof t !== "object") return "目标必须是对象";
  if (!t.id || !/^[\w.-]{1,64}$/.test(t.id)) return "id 必填,只允许字母数字下划线点横线(≤64)";
  if (!t.label) return "label 必填";

  const checkExtract = (ex, where = "") => {
    if (!ex) return null;
    if (!EXTRACT_TYPES.includes(ex.type)) return `${where}extract.type 只能是 ${EXTRACT_TYPES.join(" / ")}`;
    if (ex.type === "regex" && !ex.pattern) return `${where}regex 提取必须提供 pattern`;
    return null;
  };

  // 多步写法:每一步各自有 url 与 extract;最后一步的 extract 就是被监控的值
  if (Array.isArray(t.steps) && t.steps.length) {
    if (t.steps.length > 8) return "步骤最多 8 步";
    for (let i = 0; i < t.steps.length; i++) {
      const s = t.steps[i];
      if (!s || typeof s !== "object") return `第 ${i + 1} 步必须是一个对象`;
      if (!s.url || !/^https?:\/\//.test(s.url)) return `第 ${i + 1} 步 url 必填且必须 http/https`;
      const e = checkExtract(s.extract, `第 ${i + 1} 步 `);
      if (e) return e;
      if (s.saveAs && !/^[\w.-]+$/.test(s.saveAs)) return `第 ${i + 1} 步 saveAs 只能是字母数字下划线`;
    }
    return null;
  }

  if (!t.url || !/^https?:\/\//.test(t.url)) return "url 必填且必须 http/https(或用 steps 做多步采集)";
  return checkExtract(t.extract);
}

async function runAll() {
  if (runtime.running) return { ok: false, code: 409, error: "已有一次采集在进行中,请稍候" };
  runtime.running = true;
  try {
    const cfg = loadConfig();
    const run = await collectAll(cfg, DATA_DIR);
    runtime.runsTotal++;
    runtime.lastRun = {
      at: run.at, ms: run.ms, targets: run.results.length,
      alerts: run.results.filter((r) => r.alert).length,
      errors: run.results.filter((r) => r.error).length,
    };
    runtime.lastError = null;
    // 顺手生成静态报告(便于存档 / 分享 / 邮件发送)
    try {
      const { htmlPath, csvPath } = writeReports(join(ROOT, "out"), run);
      run.report = { html: htmlPath.slice(ROOT.length + 1), csv: csvPath.slice(ROOT.length + 1) };
    } catch (e) {
      run.reportError = e.message;
    }
    // 采集完成后按配置推送通知(默认只在有告警/失败时推送,避免打扰)
    try {
      const chRes = await notify(cfg.notify, run);
      runtime.lastNotify = { at: Date.now(), results: chRes };
      run.notify = chRes;
    } catch (e) {
      runtime.lastNotify = { at: Date.now(), results: [{ type: "error", ok: false, error: e.message }] };
    }
    return { ok: true, run };
  } catch (e) {
    runtime.lastError = e.message;
    return { ok: false, code: 500, error: e.message };
  } finally {
    runtime.running = false;
  }
}

const csvOf = (results) => "\uFEFF" + ["id,label,current,previous,delta,deltaPct,unit,alert,error"]
  .concat(results.map((r) => [r.id, r.label, r.value ?? "", r.prevValue ?? "", r.delta ?? "", r.deltaPct?.toFixed(4) ?? "", r.unit ?? "", r.alert ?? "", r.error ?? ""]
    .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")))
  .join("\n");

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  try {
    /* ---- API ---- */
    if (path.startsWith("/api/")) {
      // GET /api/state
      if (method === "GET" && path === "/api/state") return sendJson(res, buildState());

      // GET /api/health
      if (method === "GET" && path === "/api/health") {
        return sendJson(res, { ok: true, uptimeSec: runtime.running ? -1 : Math.round((Date.now() - runtime.startedAt) / 1000), version: "1.0.0", node: process.version });
      }

      // POST /api/run  —— 「刷新」按钮:真的去采集
      if (method === "POST" && path === "/api/run") {
        const r = await runAll();
        if (!r.ok) return sendJson(res, { ok: false, error: r.error }, r.code);
        return sendJson(res, {
          ok: true,
          run: {
            at: r.run.at, ms: r.run.ms, results: r.run.results,
            report: r.run.report ?? null,       // 生成的静态报告路径
            reportError: r.run.reportError ?? null,
            notify: r.run.notify ?? null,       // 本次通知推送结果
          },
          state: buildState(),
        });
      }

      // POST /api/run/:id —— 只重采一个
      if (method === "POST" && path.startsWith("/api/run/")) {
        const id = decodeURIComponent(path.slice("/api/run/".length));
        const cfg = loadConfig();
        const t = cfg.targets.find((x) => x.id === id);
        if (!t) return sendJson(res, { ok: false, error: "找不到该目标" }, 404);
        const r = await collectOne(t, DATA_DIR);
        return sendJson(res, { ok: true, result: r, state: buildState() });
      }

      // POST /api/run-preview —— 测试一个目标能否取到值(不落库、不改配置)
      if (method === "POST" && path === "/api/run-preview") {
        const b = await readBody(req);
        if (!b) return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
        const err = validateTarget({ ...b, id: b.id || "preview", label: b.label || "preview" });
        if (err) return sendJson(res, { ok: false, error: err }, 400);
        try {
          const text = await getText(b.url, { timeoutMs: 15000 });
          const value = extractValue(text, b.extract);
          return sendJson(res, {
            ok: value != null && value !== "",
            value,
            hint: value == null ? "取到 null —— 检查提取路径/正则是否匹配" : undefined,
          });
        } catch (e) {
          return sendJson(res, { ok: false, error: e.message });
        }
      }

      // ---- 通知配置与测试 ----
      // GET /api/notify —— 读取通知配置
      if (method === "GET" && path === "/api/notify") {
        const cfg = loadConfig();
        return sendJson(res, { ok: true, notify: cfg.notify ?? { mode: "on-alert", channels: [] }, channelTypes: CHANNEL_TYPES });
      }
      // PUT /api/notify —— 保存通知配置
      if (method === "PUT" && path === "/api/notify") {
        const b = await readBody(req);
        if (!b || typeof b !== "object") return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
        if (b.channels && !Array.isArray(b.channels)) return sendJson(res, { ok: false, error: "channels 必须是数组" }, 400);
        for (const c of b.channels ?? []) {
          if (!c.type) return sendJson(res, { ok: false, error: "每个渠道必须有 type" }, 400);
          if (!CHANNEL_TYPES.includes(c.type)) return sendJson(res, { ok: false, error: `不支持的通知类型: ${c.type}(可用:${CHANNEL_TYPES.join("/")})` }, 400);
        }
        const cfg = loadConfig();
        cfg.notify = { mode: b.mode ?? "on-alert", channels: b.channels ?? [] };
        saveConfig(cfg);
        return sendJson(res, { ok: true, notify: cfg.notify });
      }
      // POST /api/notify-test —— 用假数据测试所有已启用渠道
      if (method === "POST" && path === "/api/notify-test") {
        const cfg = loadConfig();
        try {
          const results = await notifyTest(cfg.notify);
          return sendJson(res, { ok: results.length > 0 && results.every((r) => r.ok), results, tested: results.length });
        } catch (e) {
          return sendJson(res, { ok: false, results: [], error: e.message });
        }
      }

      // GET /api/history?id=&limit=
      if (method === "GET" && path === "/api/history") {
        const id = url.searchParams.get("id");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!id) return sendJson(res, { ok: false, error: "缺少 id" }, 400);
        return sendJson(res, { ok: true, id, history: history(DATA_DIR, id, limit) });
      }

      // POST /api/targets —— 新增
      if (method === "POST" && path === "/api/targets") {
        const body = await readBody(req);
        if (!body) return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
        const err = validateTarget(body);
        if (err) return sendJson(res, { ok: false, error: err }, 400);
        const cfg = loadConfig();
        if (cfg.targets.some((t) => t.id === body.id)) return sendJson(res, { ok: false, error: `id「${body.id}」已存在` }, 409);
        cfg.targets.push(body);
        saveConfig(cfg);
        return sendJson(res, { ok: true, target: body, state: buildState() });
      }

      // PUT /api/targets/:id —— 修改
      if (method === "PUT" && path.startsWith("/api/targets/")) {
        const id = decodeURIComponent(path.slice("/api/targets/".length));
        const body = await readBody(req);
        if (!body) return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
        const cfg = loadConfig();
        const i = cfg.targets.findIndex((t) => t.id === id);
        if (i < 0) return sendJson(res, { ok: false, error: "找不到该目标" }, 404);
        const merged = { ...cfg.targets[i], ...body, id: cfg.targets[i].id };
        const err = validateTarget(merged);
        if (err) return sendJson(res, { ok: false, error: err }, 400);
        cfg.targets[i] = merged;
        saveConfig(cfg);
        return sendJson(res, { ok: true, target: merged, state: buildState() });
      }

      // DELETE /api/targets/:id
      if (method === "DELETE" && path.startsWith("/api/targets/")) {
        const id = decodeURIComponent(path.slice("/api/targets/".length));
        const cfg = loadConfig();
        const before = cfg.targets.length;
        cfg.targets = cfg.targets.filter((t) => t.id !== id);
        if (cfg.targets.length === before) return sendJson(res, { ok: false, error: "找不到该目标" }, 404);
        saveConfig(cfg);
        return sendJson(res, { ok: true, removed: id, state: buildState() });
      }

      // 导出
      if (method === "GET" && (path === "/api/export.csv" || path === "/api/export.json")) {
        const s = stateFromHistory(loadConfig(), DATA_DIR);
        const tag = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
        if (path.endsWith(".csv"))
          return sendText(res, csvOf(s.results), 200, "text/csv; charset=utf-8",
            { "content-disposition": `attachment; filename="monitor-${tag}.csv"` });
        return sendText(res, JSON.stringify(s, null, 2), 200, "application/json; charset=utf-8",
          { "content-disposition": `attachment; filename="monitor-${tag}.json"` });
      }

      // GET /api/report/latest —— 打开最新生成的静态报告(可另存 / 转发给客户)
      if (method === "GET" && path === "/api/report/latest") {
        const outDir = join(ROOT, "out");
        const files = existsSync(outDir)
          ? readdirSync(outDir).filter((f) => f.endsWith(".html")).sort().reverse()
          : [];
        if (!files.length) return sendText(res, "还没有生成报告 —— 先点「刷新数据」采集一次", 404);
        const buf = await readFile(join(outDir, files[0]));
        return sendText(res, buf, 200, "text/html; charset=utf-8");
      }

      // GET /api/report/list —— 列出已生成的报告
      if (method === "GET" && path === "/api/report/list") {
        const outDir = join(ROOT, "out");
        const files = existsSync(outDir)
          ? readdirSync(outDir).filter((f) => f.endsWith(".html") || f.endsWith(".csv")).sort().reverse()
          : [];
        return sendJson(res, { ok: true, files });
      }

      return sendJson(res, { ok: false, error: `未知接口: ${method} ${path}` }, 404);
    }

    /* ---- 静态文件(public/) ---- */
    let rel = decodeURIComponent(path);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return sendText(res, "403", 403);
    if (!existsSync(file)) return sendText(res, "404 Not Found", 404);
    const buf = await readFile(file);
    // 本地工具:一律不缓存,避免改了界面却看到旧版
    return sendText(res, buf, 200, MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      { "cache-control": "no-store, must-revalidate" });
  } catch (e) {
    runtime.lastError = e.message;
    return sendJson(res, { ok: false, error: e.message }, 500);
  }
});

ensureDir(DATA_DIR);
ensureDir(PUBLIC_DIR);

server.listen(PORT, "127.0.0.1", () => {
  const cfg = loadConfig();
  // 注意:控制台输出一律用 ASCII —— 客户机的控制台代码页可能是 GBK,
  // 打中文会变成乱码。界面上的中文都在浏览器里(浏览器按 UTF-8 解析,永远正常)。
  console.log("");
  console.log("  ==================================================");
  console.log("    Data Monitor  -  server is running");
  console.log("  ==================================================");
  console.log(`    Console  :  http://127.0.0.1:${PORT}/`);
  console.log(`    Targets  :  ${cfg.targets.length}`);
  console.log("    Data     :  ./data        (history snapshots)");
  console.log(`    Config   :  ${CONFIG_PATH.slice(ROOT.length + 1)}`);
  console.log("  ==================================================");
  console.log("    API : GET /api/state | POST /api/run | GET /api/health");
  console.log("    Stop: press Ctrl+C, or just close this window.");
  console.log("");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("");
    console.error(`  [ERROR] Port ${PORT} is already in use.`);
    console.error(`          The monitor is probably already running.`);
    console.error(`          Just open this in your browser:  http://127.0.0.1:${PORT}/`);
    console.error(`          Or start on another port:        node server.mjs --port=4211`);
    console.error("");
  } else {
    console.error("");
    console.error("  [ERROR] " + e.message);
    console.error("");
  }
  process.exit(1);
});

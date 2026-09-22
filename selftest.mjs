#!/usr/bin/env node
// 自检脚本 —— 不联网、不碰你的真实配置,用本地模拟站点把核心能力跑一遍
//
//   node selftest.mjs
//
// 覆盖:单请求提取 / 多步登录 / Cookie 会话 / 变量插值 / 失败提示 /
//       通知消息生成 / 告警判定 / 历史比对 / API 服务
// 退出码:0 全部通过 / 1 有失败

import http from "node:http";
import { collectOne } from "./lib/collect.mjs";
import { CookieJar, request } from "./lib/fetch.mjs";
import { judge, diffOf, stepsOf } from "./lib/collect.mjs";
import { buildMessage, shouldNotify } from "./lib/notify.mjs";
import { append, history, stats, ensureDir } from "./lib/store.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  → " + extra : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ============================ 本地模拟站点 ============================ */
const SITE_PORT = 4340;
const BASE = `http://127.0.0.1:${SITE_PORT}`;

const site = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  // 登录:正确则下发 Cookie + 页面里带 CSRF token
  if (u.pathname === "/login" && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const p = new URLSearchParams(b);
      if (p.get("user") === "demo" && p.get("pass") === "secret") {
        res.writeHead(200, { "set-cookie": ["sid=abc123; Path=/", "csrf=tok456; Path=/"], "content-type": "text/html; charset=utf-8" });
        res.end('<html><body><input name="csrf" value="tok456"></body></html>');
      } else {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>用户名或密码错误</body></html>");
      }
    });
    return;
  }
  // 数据接口:同时校验 Cookie 与 token
  if (u.pathname === "/api/stats") {
    const ck = req.headers.cookie || "";
    if (!ck.includes("sid=abc123")) { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden: no session"); return; }
    if (u.searchParams.get("t") !== "tok456") { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden: bad token"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { count: 4321 } }));
    return;
  }
  if (u.pathname === "/plain") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: 99 }));
    return;
  }
  if (u.pathname === "/version") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><body><span class="v">v2.4.1</span></body></html>');
    return;
  }
  if (u.pathname === "/slow") { return; }   // 永不响应,用来测超时
  res.writeHead(404); res.end("not found");
});

await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
const dataDir = mkdtempSync(join(tmpdir(), "dm-selftest-"));
ensureDir(dataDir);
console.log("数据监控台 · 自检");
console.log(`模拟站点 ${BASE} ｜ 临时数据目录 ${dataDir}`);

/* ============================ ① 单请求提取 ============================ */
section("① 单请求提取");
const t1 = await collectOne({ id: "s1", label: "JSON 提取", url: `${BASE}/plain`, extract: { type: "json", path: "value" } }, dataDir);
ok(t1.ok && t1.value === 99, "json 路径提取", `value=${t1.value}`);

const t2 = await collectOne({ id: "s2", label: "正则提取", url: `${BASE}/version`, extract: { type: "regex", pattern: 'class="v">([^<]+)<' } }, dataDir);
ok(t2.ok && t2.value === "v2.4.1", "regex 提取", `value=${t2.value}`);

const t3 = await collectOne({ id: "s3", label: "长度", url: `${BASE}/plain`, extract: { type: "length" } }, dataDir);
ok(t3.ok && typeof t3.value === "number" && t3.value > 0, "length 提取", `value=${t3.value}`);

/* ============================ ② 多步登录 + Cookie + 插值 ============================ */
section("② 多步登录采集(登录 → 取 token → 带 Cookie+token 取数据)");
const t4 = await collectOne({
  id: "s4", label: "登录后的统计数", unit: "条",
  steps: [
    { url: `${BASE}/login`, method: "POST", bodyType: "form", body: { user: "demo", pass: "secret" },
      extract: { type: "regex", pattern: 'name="csrf" value="([^"]+)"' }, saveAs: "csrf" },
    { url: `${BASE}/api/stats?t={{csrf}}`, extract: { type: "json", path: "data.count" } },
  ],
}, dataDir);
ok(t4.ok && t4.value === 4321, "多步 + 变量插值 + Cookie 传递", `value=${t4.value} err=${t4.error ?? "-"}`);
ok(t4.multiStep && t4.stepCount === 2, "步骤数识别", `stepCount=${t4.stepCount}`);
ok(Array.isArray(t4.trace) && t4.trace.length === 2 && t4.trace[0].savedAs === "csrf", "步骤轨迹可追踪");

/* ============================ ③ 登录失败要报清楚 ============================ */
section("③ 失败路径");
const t5 = await collectOne({
  id: "s5", label: "密码错误",
  steps: [
    { url: `${BASE}/login`, method: "POST", bodyType: "form", body: { user: "demo", pass: "WRONG" }, saveAs: "x", extract: { type: "text" } },
    { url: `${BASE}/api/stats?t=x`, extract: { type: "json", path: "data.count" } },
  ],
}, dataDir);
ok(!t5.ok && /401/.test(t5.error ?? ""), "非 2xx 识别为失败且带状态码", t5.error);
ok(/错误/.test(t5.error ?? ""), "错误信息包含页面提示,便于排障");

const t6 = await collectOne({ id: "s6", label: "超时", url: `${BASE}/slow`, extract: { type: "text" }, timeoutMs: 1200 }, dataDir);
ok(!t6.ok && /超时/.test(t6.error ?? ""), "超时被捕获(不会挂死)", t6.error);

/* ============================ ④ Cookie 会话 ============================ */
section("④ Cookie 会话");
const jar = new CookieJar();
await request(`${BASE}/login`, { method: "POST", bodyType: "form", body: { user: "demo", pass: "secret" }, jar });
ok(jar.size === 2 && jar.toObject().sid === "abc123", "登录后 jar 捕获到 Cookie", JSON.stringify(jar.toObject()));
const r4 = await request(`${BASE}/api/stats?t=tok456`, { jar });
ok(r4.ok && JSON.parse(r4.text).data.count === 4321, "复用会话 jar 能取到数据");

const t7 = await collectOne({ id: "s7", label: "手填 cookie", url: `${BASE}/api/stats?t=tok456`, cookies: { sid: "abc123" }, extract: { type: "json", path: "data.count" } }, dataDir);
ok(t7.ok && t7.value === 4321, "手填 Cookie 直接可用");

/* ============================ ⑤ 向后兼容 ============================ */
section("⑤ 配置兼容");
ok(stepsOf({ url: "a" }).length === 1, "旧的 url+extract 写法归一化为 1 步");
ok(stepsOf({ steps: [{ url: "a" }, { url: "b" }] }).length === 2, "steps 写法保持原样");

/* ============================ ⑥ 变化比对与告警 ============================ */
section("⑥ 变化比对与告警");
const d1 = diffOf(100, 90, true);
ok(d1.delta === 10 && Math.abs(d1.deltaPct - 11.1111) < 0.01, "数值变化量与百分比");
const d2 = diffOf("v2", "v1", true);
ok(d2.changed === true && d2.delta === null, "字符串只判断是否变更");
const d3 = diffOf(5, null, false);
ok(d3.delta === null && d3.changed === undefined, "首次采集不算变化");

ok(judge({ changePct: 3 }, { value: 100, deltaPct: 5 }, null) !== null, "changePct 规则触发");
ok(judge({ changePct: 3 }, { value: 100, deltaPct: 1 }, null) === null, "未达阈值不触发");
ok(judge({ above: 50 }, { value: 60 }, null) !== null, "above 规则触发");
ok(judge({ below: 50 }, { value: 60 }, null) === null, "below 规则不误触发");
ok(judge({ changed: true }, { value: "b", changed: true }, null) !== null, "changed 规则触发");
ok(judge({ z: 2 }, { value: 100 }, { mean: 10, sd: 1 }) !== null, "σ 统计异常触发");

/* ============================ ⑦ 历史与统计 ============================ */
section("⑦ 历史与统计");
for (let i = 0; i < 5; i++) append(dataDir, "hist", { ts: Date.now() + i, value: i * 10 });
ok(history(dataDir, "hist").length === 5, "历史快照追加");
ok(history(dataDir, "hist", 2).length === 2, "按条数截取历史");
const st = stats(dataDir, "hist");
ok(st && st.n === 5 && st.min === 0 && st.max === 40, "统计量计算", JSON.stringify(st));

/* ============================ ⑧ 通知消息 ============================ */
section("⑧ 通知消息生成");
const msg = buildMessage({
  at: Date.now(), title: "自检",
  results: [
    { id: "a", label: "指标A", value: 128, unit: "元", prevValue: 120, delta: 8, deltaPct: 6.67, alert: "环比 +6.67%" },
    { id: "b", label: "页面B", value: null, error: "请求超时(15000ms)" },
  ],
});
ok(msg.summary.alerts === 1 && msg.summary.errors === 1, "摘要统计正确", JSON.stringify(msg.summary));
ok(/🔴/.test(msg.text) && /指标A/.test(msg.text), "消息正文包含失败与告警");
ok(shouldNotify(msg, "on-alert") === true, "有告警时应推送");
const calm = buildMessage({ at: Date.now(), title: "静", results: [{ id: "x", label: "平静", value: 1, prevValue: 1, delta: 0 }] });
ok(shouldNotify(calm, "on-alert") === false, "全持平时应静默(on-alert)");
ok(shouldNotify(calm, "always") === true, "always 模式始终推送");

/* ============================ 汇总 ============================ */
site.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${"─".repeat(46)}`);
console.log(`  自检结果:${pass} 项通过${fail ? `,${fail} 项失败` : ""}`);
console.log(`${"─".repeat(46)}\n`);
process.exit(fail ? 1 : 0);

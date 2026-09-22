#!/usr/bin/env node
// 《数据监控日报机器人》
// 用法:
//   node monitor.mjs                        # 用 config.json 跑一次
//   node monitor.mjs --config=my.json       # 指定配置
//   node monitor.mjs --json                 # 额外输出机器可读的 JSON 摘要
// 退出码:0=全部正常 / 1=有告警 / 2=有采集失败(可直接给定时任务判断)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getText } from "./lib/fetch.mjs";
import { extractValue, fingerprint } from "./lib/extract.mjs";
import { append, previous, stats, history } from "./lib/store.mjs";
import { writeReports } from "./lib/report.mjs";
import { notify } from "./lib/notify.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const argOf = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const cfgPath = argOf("config") ?? join(ROOT, "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const DATA_DIR = join(ROOT, "data");
const OUT_DIR = join(ROOT, "out");

/** 告警判定:支持 内容变更 / 变化率 / 高于 / 低于 / 统计异常(σ) */
function judge(rule, r, st) {
  if (!rule) return null;
  // 非数值目标:只能判断"是否变更"(版本更新、页面改版、状态切换)
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

const fmt = (v) => (v == null ? "—" : typeof v === "number" ? v.toLocaleString("zh-CN") : String(v));
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, n - w));
};

const t0 = Date.now();
console.log(`\n📊 ${cfg.name}`);
console.log(`   配置: ${cfgPath}`);
console.log(`   时间: ${new Date().toLocaleString("zh-CN")}\n`);

const results = [];
for (const t of cfg.targets) {
  const r = { id: t.id, label: t.label, unit: t.unit ?? "" };
  try {
    const text = await getText(t.url, { timeoutMs: t.timeoutMs ?? 15000, headers: t.headers });
    const value = extractValue(text, t.extract);
    const prev = previous(DATA_DIR, t.id);
    r.value = value;
    r.prevValue = prev?.value ?? null;
    r.fp = fingerprint(text);

    if (typeof value === "number" && typeof prev?.value === "number") {
      r.delta = +(value - prev.value).toFixed(4);
      r.deltaPct = prev.value !== 0 ? +(((value - prev.value) / Math.abs(prev.value)) * 100).toFixed(4) : null;
    } else if (prev) {
      // 非数值(版本号 / 文案 / 状态):数值差没意义,只判断"是否变更"
      r.changed = String(value) !== String(prev.value);
    }
    r.alert = judge(t.alert, r, stats(DATA_DIR, t.id));
    append(DATA_DIR, t.id, { ts: Date.now(), value, fp: r.fp });
    // 供报告画走势图:最近 28 次数值型历史(含本次)
    r.spark = history(DATA_DIR, t.id, 28).map((x) => (typeof x.value === "number" ? x.value : null)).filter((x) => x !== null);
  } catch (e) {
    r.error = e.message;
  }
  results.push(r);

  const mark = r.error ? "✗" : r.alert ? "!" : "✓";
  const change = r.error ? r.error.slice(0, 30)
    : r.changed !== undefined ? (r.changed ? `已变更(原 ${String(r.prevValue).slice(0, 14)})` : "未变更")
    : r.delta == null ? "(首次采集)"
    : r.delta === 0 ? "持平"
    : `${r.delta > 0 ? "+" : ""}${fmt(r.delta)}${r.deltaPct != null ? ` (${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(2)}%)` : ""}`;
  console.log(`  ${mark} ${pad(r.label, 30)} ${pad(fmt(r.value) + (r.unit ? " " + r.unit : ""), 18)} ${change}${r.alert ? `   ⚠ ${r.alert}` : ""}`);
}

const run = { at: Date.now(), title: cfg.name, results, ms: Date.now() - t0 };
const { htmlPath, csvPath } = writeReports(OUT_DIR, run);

const alerts = results.filter((r) => r.alert).length;
const errors = results.filter((r) => r.error).length;

// 推送通知(按 config.json 的 notify 段;默认只在有告警/失败时推,全持平时静默)
let notifyResults = [];
try {
  notifyResults = await notify(cfg.notify, run);
} catch (e) {
  notifyResults = [{ type: "error", ok: false, error: e.message }];
}

console.log(`\n  汇总: ${results.length} 个目标 ｜ 变化 ${results.filter((r) => r.delta).length} ｜ 告警 ${alerts} ｜ 失败 ${errors}`);
if (notifyResults.length) {
  console.log("  通知: " + notifyResults.map((r) =>
    `${r.type}${r.ok ? " ✓" : " ✗ " + (r.error ?? "")}${r.reason ? `(${r.reason})` : ""}`).join("  "));
}
console.log(`  报告: ${htmlPath}`);
console.log(`  数据: ${csvPath}\n`);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ at: run.at, targets: results.length, alerts, errors, notify: notifyResults, results }, null, 2));
}

process.exit(errors > 0 ? 2 : alerts > 0 ? 1 : 0);

// 报告层 v3 —— 企业级监控控制台
//
// 参考「2025 控制台设计」范式:侧边导航 + 顶栏 + KPI 卡(图标/数字/增减徽标)
//                            + 趋势图 + 环形图 + 企业化数据表
// 全部零依赖:图表用纯 SVG 几何计算,不引任何图表库。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./store.mjs";

/* ============================ 工具 ============================ */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (v) => {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("zh-CN") : v.toFixed(3).replace(/\.?0+$/, "");
  const s = String(v);
  return s.length > 20 ? s.slice(0, 19) + "…" : s;
};
const compact = (n) => {
  if (typeof n !== "number") return fmt(n);
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (a >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return n.toLocaleString("zh-CN");
};

const isActive = (r) => !!(r.error || r.alert || r.changed === true || (r.delta != null && r.delta !== 0));
const rank = (r) => (r.error ? 0 : r.alert ? 1 : isActive(r) ? 2 : 3);
const sortRows = (rs) => rs.slice().sort((a, b) => {
  const d = rank(a) - rank(b);
  if (d) return d;
  return Math.abs(b.deltaPct ?? b.delta ?? 0) - Math.abs(a.deltaPct ?? a.delta ?? 0);
});

/* ============================ 图标(内联 SVG) ============================ */
const I = {
  radar: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 8a4 4 0 1 0 4 4"/><path d="M12 12l7-7"/>',
  pulse: '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
  alert: '<path d="M12 3.5 22 20H2z"/><path d="M12 10v4"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0v4.5l1.5 2.5h-15L6 13.5z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.6l2 1.2M17.5 15.2l2 1.2M4.5 16.4l2-1.2M17.5 8.8l2-1.2"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 17h10v3H7z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  trend: '<path d="M3 17l5-6 4 4 9-9"/><path d="M15 6h6v6"/>',
};
const icon = (k, size = 16) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[k] ?? ""}</svg>`;

/* ============================ 图表(纯 SVG 几何) ============================ */

/** 迷你走势(sparkline):表格每行的趋势列 */
function sparkline(vals, { w = 92, h = 26 } = {}) {
  const n = vals.filter((v) => typeof v === "number");
  if (n.length < 2) return '<span class="mut">—</span>';
  const min = Math.min(...n), max = Math.max(...n), span = max - min || 1;
  const step = w / (n.length - 1);
  const pts = n.map((v, i) => [i * step, h - 3 - ((v - min) / span) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const up = n[n.length - 1] >= n[0];
  const c = up ? "var(--pos)" : "var(--neg)";
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <path d="${d} L${w} ${h} L0 ${h} Z" fill="currentColor" class="spark-fill ${up ? "up" : "down"}"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.3" fill="${c}"/>
  </svg>`;
}

/** 面积趋势图(带网格与起止标签) */
function areaChart(vals, labels, { w = 720, h = 168 } = {}) {
  const n = vals.filter((v) => typeof v === "number");
  if (n.length < 2) return '<div class="empty">历史数据不足,再跑几次就有趋势了</div>';
  const padL = 8, padR = 8, padT = 12, padB = 22;
  const iw = w - padL - padR, ih = h - padT - padB;
  const min = Math.min(...n), max = Math.max(...n), span = max - min || 1;
  const step = iw / (n.length - 1);
  const pts = n.map((v, i) => [padL + i * step, padT + ih - ((v - min) / span) * ih]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${(padL + iw).toFixed(1)} ${(padT + ih).toFixed(1)} L${padL} ${(padT + ih).toFixed(1)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + ih * f;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + iw}" y2="${y.toFixed(1)}" class="gridline"/>`;
  }).join("");
  const yLabels = [max, min].map((v, i) => `<text x="${padL + iw}" y="${(padT + ih * i + (i ? 12 : -2)).toFixed(1)}" class="axis" text-anchor="end">${compact(v)}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="area" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--primary)" stop-opacity=".22"/>
      <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#ag)"/>
    <path d="${line}" fill="none" stroke="var(--primary)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="3.4" fill="#fff" stroke="var(--primary)" stroke-width="2.4"/>
    ${yLabels}
    <text x="${padL}" y="${h - 4}" class="axis">${esc(labels?.[0] ?? "")}</text>
    <text x="${padL + iw}" y="${h - 4}" class="axis" text-anchor="end">${esc(labels?.[1] ?? "")}</text>
  </svg>`;
}

/** 环形图(状态构成) */
function donut(segs, { size = 150, thickness = 17 } = {}) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  const r = (size - thickness) / 2, c = size / 2;
  const active = segs.filter((s) => s.value > 0);
  if (!total || active.length === 0) return `<div class="empty" style="height:${size}px">暂无数据</div>`;
  if (active.length === 1) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${active[0].color}" stroke-width="${thickness}"/></svg>`;
  }
  let a0 = -Math.PI / 2;
  const arcs = active.map((s) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const x1 = c + r * Math.cos(a0), y1 = c + r * Math.sin(a0);
    const x2 = c + r * Math.cos(a0 + sweep), y2 = c + r * Math.sin(a0 + sweep);
    const large = sweep > Math.PI ? 1 : 0;
    a0 += sweep;
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"
             fill="none" stroke="${s.color}" stroke-width="${thickness}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${arcs}</svg>`;
}

/* ============================ 单元格 ============================ */
function valueCell(r) {
  if (r.error) return '<span class="neg">采集失败</span>';
  return `${esc(compact(r.value))}${r.unit ? `<i class="u">${esc(r.unit)}</i>` : ""}`;
}
function deltaCell(r) {
  if (r.error) return `<span class="mut">—</span>`;
  if (r.changed !== undefined) {
    return r.changed ? '<span class="badge pos">已变更</span>' : '<span class="mut">未变更</span>';
  }
  if (r.delta == null) return '<span class="badge neu">首次</span>';
  if (r.delta === 0) return '<span class="mut">持平</span>';
  const up = r.delta > 0;
  return `<span class="badge ${up ? "pos" : "neg"}">${up ? "▲" : "▼"} ${esc(compact(Math.abs(r.delta)))}</span>`;
}
function pctCell(r) {
  if (r.deltaPct == null) return '<span class="mut">—</span>';
  const v = r.deltaPct;
  if (v === 0) return '<span class="mut">0.00%</span>';
  return `<span class="${v > 0 ? "pos" : "neg"} mono">${v > 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
}
function statusCell(r) {
  if (r.error) return `<span class="chip neg" title="${esc(r.error)}">采集失败</span>`;
  if (r.alert) return `<span class="chip warn">${esc(r.alert)}</span>`;
  if (isActive(r)) return '<span class="chip info">有变化</span>';
  return '<span class="chip ok">正常</span>';
}

const rowHtml = (r) => `
        <tr class="${r.error ? "row-fail" : r.alert ? "row-warn" : ""}">
          <td class="col-name">
            <span class="avatar">${esc((r.label || "?").trim().slice(0, 1))}</span>
            <span class="meta"><b>${esc(r.label)}</b><i>${esc(r.id)}</i></span>
          </td>
          <td class="num strong">${valueCell(r)}</td>
          <td class="num mut">${r.error ? "—" : esc(compact(r.prevValue))}</td>
          <td class="num">${deltaCell(r)}</td>
          <td class="num">${pctCell(r)}</td>
          <td class="num trend">${sparkline(r.spark ?? [])}</td>
          <td class="col-status">${statusCell(r)}</td>
        </tr>`;

/* ============================ 主入口 ============================ */
export function writeReports(outDir, run) {
  ensureDir(outDir);
  const d = new Date(run.at);
  const p = (n) => String(n).padStart(2, "0");
  const tag = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;

  const sorted = sortRows(run.results);
  const active = sorted.filter(isActive);
  const rest = sorted.filter((r) => !isActive(r));
  const alerts = run.results.filter((r) => r.alert);
  const errors = run.results.filter((r) => r.error);
  const changed = run.results.filter((r) => r.changed === true || (r.delta != null && r.delta !== 0));
  const quiet = run.results.length - active.length;

  // 顶栏结论
  const headline = errors.length ? `${errors.length} 项采集失败,需立即处理`
    : alerts.length ? `${alerts.length} 项触发告警`
    : changed.length ? `${changed.length} 项发生变化,全部正常`
    : "全部持平,无异常";
  const tone = errors.length || alerts.length ? "bad" : changed.length ? "warn" : "ok";

  // 趋势图:选"变化最活跃"的目标(而不是历史点最多的)—— 否则画出来是一条平线,没有信息量
  const variation = (arr) => {
    if (!arr || arr.length < 3) return -1;
    const min = Math.min(...arr), max = Math.max(...arr), mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return (max - min) / (Math.abs(mean) || 1);
  };
  const seriesTarget = run.results.filter((r) => (r.spark?.length ?? 0) > 2)
    .sort((a, b) => variation(b.spark) - variation(a.spark))[0];
  const histAll = seriesTarget ? seriesTarget.spark.slice(-40) : [];
  const histLabels = histAll.length > 1 ? [`${histAll.length} 次前`, "本次"] : [];

  // 环形图:状态构成
  const donutSegs = [
    { label: "正常", value: run.results.length - active.length, color: "var(--line-strong)" },
    { label: "有变化", value: changed.length, color: "var(--primary)" },
    { label: "告警", value: alerts.length, color: "var(--warn)" },
    { label: "失败", value: errors.length, color: "var(--neg)" },
  ].filter((s) => s.value > 0);

  const kpis = [
    { k: "radar", label: "监控目标", v: run.results.length, sub: "个" },
    { k: "pulse", label: "发生变化", v: changed.length, sub: active.length ? `共 ${active.length} 项需关注` : "无变化" },
    { k: "alert", label: "触发告警", v: alerts.length, cls: alerts.length ? "warn" : "", sub: alerts.length ? "需处理" : "全部正常" },
    { k: "xcircle", label: "采集失败", v: errors.length, cls: errors.length ? "neg" : "", sub: errors.length ? "见明细" : "全部成功" },
  ].map((x) => `
      <article class="kpi ${x.cls ?? ""}">
        <div class="kpi-top">${icon(x.k, 15)}<span>${x.label}</span></div>
        <div class="kpi-v">${x.v}<i>${x.sub}</i></div>
      </article>`).join("");

  const navGroups = [
    { t: "监控", items: [["grid", "总览", true], ["pulse", "趋势", false], ["bell", "告警", false]] },
    { t: "配置", items: [["gear", "监控目标", false], ["print", "导出报告", false]] },
  ].map((g) => `
      <div class="nav-group">
        <div class="nav-t">${g.t}</div>
        ${g.items.map(([ic, label, on]) => `<a class="nav-i ${on ? "on" : ""}" href="#top">${icon(ic, 15)}<span>${label}</span></a>`).join("")}
      </div>`).join("");

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>数据监控控制台 · ${tag}</title>
<style>
  :root{
    --bg:#f4f6fa; --surface:#fff; --line:#e8ecf2; --line-2:#f1f5f9; --line-strong:#cbd5e1;
    --txt:#0f172a; --txt-2:#475569; --mut:#8a94a6;
    --primary:#4f46e5; --primary-soft:#eef2ff;
    --pos:#0f9d58; --neg:#e5484d; --warn:#f59e0b;
    --r:12px; --r-sm:9px;
    --sh:0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.04);
    --fs:13.5px; --fs-sm:12px; --fs-xs:11px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font-family:"PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;
    font-size:var(--fs);line-height:1.5;-webkit-font-smoothing:antialiased}
  .ic{flex:none}
  .mono,.num{font-variant-numeric:tabular-nums}
  .pos{color:var(--pos)}.neg{color:var(--neg)}.mut{color:var(--mut)}.strong{font-weight:700}
  .u{font-style:normal;color:var(--mut);font-size:var(--fs-xs);margin-left:3px}

  /* ---------- 布局:侧栏 + 主区 ---------- */
  .app{display:grid;grid-template-columns:228px 1fr;min-height:100vh}

  /* ---------- 侧栏 ---------- */
  .side{background:var(--surface);border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:6px}
  .brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:15px;letter-spacing:-.01em;padding:0 6px 14px}
  .brand i{width:26px;height:26px;border-radius:8px;background:var(--primary);color:#fff;display:flex;
           align-items:center;justify-content:center;font-style:normal;font-size:13px}
  .search{display:flex;align-items:center;gap:7px;background:var(--line-2);border:1px solid var(--line);
          border-radius:var(--r-sm);padding:7px 10px;color:var(--mut);font-size:var(--fs-sm);margin-bottom:8px}
  .nav-group{margin-top:10px}
  .nav-t{font-size:10.5px;font-weight:800;color:var(--mut);letter-spacing:.1em;text-transform:uppercase;padding:0 8px 6px}
  .nav-i{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:var(--r-sm);color:var(--txt-2);
         text-decoration:none;font-size:var(--fs-sm);font-weight:600}
  .nav-i:hover{background:var(--line-2);color:var(--txt)}
  .nav-i.on{background:var(--primary-soft);color:var(--primary)}

  /* ---------- 主区 ---------- */
  main{padding:22px 26px 40px;min-width:0}
  .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:20px}
  .topbar h1{margin:0 0 4px;font-size:20px;font-weight:800;letter-spacing:-.01em}
  .topbar p{margin:0;color:var(--mut);font-size:var(--fs-sm)}
  .actions{display:flex;gap:8px;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--surface);
       color:var(--txt-2);border-radius:var(--r-sm);padding:8px 13px;font:inherit;font-size:var(--fs-sm);
       font-weight:600;cursor:pointer;box-shadow:var(--sh)}
  .btn:hover{border-color:var(--line-strong);color:var(--txt)}
  .btn.p{background:var(--primary);border-color:var(--primary);color:#fff}
  .btn.p:hover{background:#4338ca;border-color:#4338ca;color:#fff}

  /* ---------- 结论条 ---------- */
  .verdict{display:flex;align-items:center;gap:10px;padding:11px 15px;border-radius:var(--r);margin-bottom:18px;
           font-weight:700;font-size:var(--fs);border:1px solid}
  .verdict .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .verdict.ok{background:#f0fdf4;border-color:#c9ecd6;color:#0b7a46}.verdict.ok .dot{background:var(--pos)}
  .verdict.warn{background:#fffbeb;border-color:#f6e0b0;color:#b45309}.verdict.warn .dot{background:var(--warn)}
  .verdict.bad{background:#fef2f2;border-color:#f5c9c9;color:#b42318}.verdict.bad .dot{background:var(--neg)}

  /* ---------- KPI 卡 ---------- */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
  .kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:15px 16px;box-shadow:var(--sh)}
  .kpi-top{display:flex;align-items:center;gap:7px;color:var(--mut);font-size:var(--fs-sm);font-weight:700;margin-bottom:9px}
  .kpi-v{font-size:27px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px}
  .kpi-v i{font-size:var(--fs-xs);font-weight:600;color:var(--mut);font-style:normal}
  .kpi.warn{border-color:#f6e0b0;background:linear-gradient(180deg,#fffdf6,#fff)}
  .kpi.warn .kpi-v{color:var(--warn)}.kpi.warn .kpi-top{color:var(--warn)}
  .kpi.neg{border-color:#f5c9c9;background:linear-gradient(180deg,#fff8f8,#fff)}
  .kpi.neg .kpi-v{color:var(--neg)}.kpi.neg .kpi-top{color:var(--neg)}

  /* ---------- 图表区 ---------- */
  .charts{display:grid;grid-template-columns:1.9fr 1fr;gap:14px;margin-bottom:18px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
  .card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 10px}
  .card-h h2{margin:0;font-size:14px;font-weight:800}
  .card-h .sub{color:var(--mut);font-size:var(--fs-xs);font-weight:600}
  .card-b{padding:0 16px 16px}
  .area{width:100%;height:172px;display:block}
  .gridline{stroke:var(--line);stroke-width:1;stroke-dasharray:3 4}
  .axis{fill:var(--mut);font-size:10px;font-weight:600}
  .spark{display:block}
  .spark-fill{opacity:.10}.spark-fill.up{color:var(--pos)}.spark-fill.down{color:var(--neg)}
  .donut-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;padding-top:6px}
  .donut-c{position:relative;display:flex;align-items:center;justify-content:center}
  .donut-c .mid{position:absolute;text-align:center;line-height:1.15}
  .donut-c .mid b{display:block;font-size:24px;font-weight:800;font-variant-numeric:tabular-nums}
  .donut-c .mid span{font-size:10.5px;color:var(--mut);font-weight:700}
  .legend{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:center;font-size:var(--fs-xs);color:var(--txt-2);font-weight:600}
  .legend span{display:flex;align-items:center;gap:6px}
  .legend em{width:9px;height:9px;border-radius:3px;display:inline-block;font-style:normal}

  /* ---------- 企业化表格 ---------- */
  .tablecard{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
  .tablecard .card-h{border-bottom:1px solid var(--line);padding-bottom:14px}
  .chips{display:flex;gap:6px}
  .fchip{font-size:var(--fs-xs);font-weight:700;color:var(--mut);border:1px solid var(--line);border-radius:20px;
         padding:3px 10px;background:var(--line-2)}
  .fchip.on{background:var(--primary);border-color:var(--primary);color:#fff}
  .tw{overflow-x:auto}
  table{width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{position:sticky;top:0;z-index:1;background:#fbfcfe;color:var(--mut);font-size:var(--fs-xs);
           font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line)}
  td.num,th.num{text-align:right}
  tbody tr:hover{background:#fafbff}
  tbody tr:last-child td{border-bottom:0}
  .row-warn{background:#fffdf6}.row-warn:hover{background:#fffaec}
  .row-fail{background:#fff8f8}.row-fail:hover{background:#fff2f2}
  .col-name{display:flex;align-items:center;gap:10px;min-width:210px;white-space:normal}
  .avatar{width:30px;height:30px;border-radius:9px;background:var(--primary-soft);color:var(--primary);
          display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:none}
  .col-name .meta{display:flex;flex-direction:column;min-width:0}
  .col-name .meta b{font-size:var(--fs);font-weight:700}
  .col-name .meta i{font-style:normal;color:var(--mut);font-size:10.5px;font-family:ui-monospace,Consolas,monospace}
  .badge{display:inline-block;font-size:var(--fs-xs);font-weight:800;border-radius:6px;padding:2px 7px}
  .badge.pos{background:#eafaf1;color:#0b7a46}
  .badge.neg{background:#fdecec;color:#b42318}
  .badge.neu{background:var(--line-2);color:var(--mut)}
  .chip{display:inline-block;font-size:var(--fs-xs);font-weight:700;border-radius:20px;padding:3px 10px}
  .chip.ok{background:#eafaf1;color:#0b7a46}
  .chip.info{background:var(--primary-soft);color:var(--primary)}
  .chip.warn{background:#fef3c7;color:#b45309}
  .chip.neg{background:#fdecec;color:#b42318}
  .trend{width:110px}
  .empty{color:var(--mut);font-size:var(--fs-sm);padding:22px;text-align:center}
  .card-f{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;
          border-top:1px solid var(--line);color:var(--mut);font-size:var(--fs-xs);font-weight:600;background:#fbfcfe}
  details.fold{border-top:1px solid var(--line);background:#fbfcfe}
  details.fold summary{cursor:pointer;padding:12px 16px;font-size:var(--fs-xs);font-weight:800;color:var(--mut);
                       letter-spacing:.04em;list-style:none;display:flex;align-items:center;gap:8px}
  details.fold summary::-webkit-details-marker{display:none}
  details.fold summary::before{content:"▸";transition:.15s}
  details.fold[open] summary::before{transform:rotate(90deg)}
  details.fold .tw{border-top:1px solid var(--line);background:var(--surface)}
  footer{margin-top:18px;color:var(--mut);font-size:var(--fs-xs);line-height:1.9}
  code{background:var(--line-2);border-radius:4px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace}

  /* ---------- 响应式 ---------- */
  @media (max-width:1080px){
    .app{grid-template-columns:1fr}
    .side{flex-direction:row;align-items:center;gap:12px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px}
    .brand{padding:0 10px 0 0}.search{display:none}.nav-group{margin:0;display:flex;gap:4px}.nav-t{display:none}
    .charts{grid-template-columns:1fr}
  }
  @media (max-width:760px){
    main{padding:16px 14px 32px}
    .kpis{grid-template-columns:repeat(2,1fr)}
    .col-name{min-width:150px}
  }
  /* ---------- 打印 ---------- */
  @media print{
    body{background:#fff}
    .app{grid-template-columns:1fr}
    .side,.actions,.search,details.fold summary{display:none}
    .card,.kpi,.tablecard{box-shadow:none}
    details.fold{display:block}
    details.fold .tw{display:block;border-top:1px solid var(--line)}
    .tw{overflow:visible}
    main{padding:0}
  }
</style></head><body>
<div class="app">

  <aside class="side">
    <div class="brand"><i>监</i>数据监控台</div>
    <div class="search">${icon("search", 14)}<span>搜索监控目标</span></div>
    ${navGroups}
  </aside>

  <main id="top">
    <div class="topbar">
      <div>
        <h1>${esc(run.title)}</h1>
        <p>${d.toLocaleString("zh-CN")} 生成 · ${run.results.length} 个监控目标 · 采集耗时 ${(run.ms / 1000).toFixed(1)}s</p>
      </div>
      <div class="actions">
        <button class="btn" onclick="window.print()">${icon("print", 14)} 导出 PDF</button>
        <button class="btn p" onclick="location.reload()">${icon("refresh", 14)} 刷新</button>
      </div>
    </div>

    <div class="verdict ${tone}"><span class="dot"></span>${headline}</div>

    <section class="kpis">${kpis}</section>

    <section class="charts">
      <div class="card">
        <div class="card-h">
          <h2>${icon("trend", 15)} 走势 · ${esc(seriesTarget?.label ?? "暂无")}</h2>
          <span class="sub">最近 ${histAll.length} 次采集</span>
        </div>
        <div class="card-b">${areaChart(histAll, histLabels)}</div>
      </div>
      <div class="card">
        <div class="card-h"><h2>状态构成</h2></div>
        <div class="card-b donut-wrap">
          <div class="donut-c">
            ${donut(donutSegs)}
            <div class="mid"><b>${changed.length}</b><span>项有变化</span></div>
          </div>
          <div class="legend">
            ${donutSegs.map((s) => `<span><em style="background:${s.color}"></em>${s.label} ${s.value}</span>`).join("")}
          </div>
        </div>
      </div>
    </section>

    <section class="tablecard">
      <div class="card-h">
        <h2>监控明细 <span class="sub">· 共 ${run.results.length} 项,${active.length} 项需关注</span></h2>
        <div class="chips">
          <span class="fchip on">全部</span>
          <span class="fchip">有变化</span>
          <span class="fchip">告警 ${alerts.length}</span>
          <span class="fchip">失败 ${errors.length}</span>
        </div>
      </div>
      <div class="tw">
        <table>
          <thead><tr>
            <th>监控目标</th><th class="num">当前值</th><th class="num">上次值</th>
            <th class="num">变化</th><th class="num">变化率</th><th class="num">近期走势</th><th>状态</th>
          </tr></thead>
          <tbody>${active.length ? active.map(rowHtml).join("") : '<tr><td colspan="7" class="empty">本次没有需要关注的变化</td></tr>'}</tbody>
        </table>
      </div>
      ${rest.length ? `
      <details class="fold">
        <summary>其余 ${rest.length} 项(未发生变化)</summary>
        <div class="tw"><table><tbody>${rest.map(rowHtml).join("")}</tbody></table></div>
      </details>` : ""}
      <div class="card-f">
        <span>显示 ${active.length} / ${run.results.length} 项</span>
        <span>数据源:各目标公开接口 / 页面 ｜ 历史快照存于 <code>data/*.jsonl</code></span>
      </div>
    </section>

    <footer>
      变化 = 本次值 − 上次值;告警规则在 <code>config.json</code> 的 <code>alert</code> 中配置
      (<code>changePct</code> / <code>above</code> / <code>below</code> / <code>z</code> / <code>changed</code>)。
      走势图取自该目标的历史快照。本页可直接打印或另存为 PDF。
    </footer>
  </main>
</div></body></html>`;

  const csv = ["id,label,current,previous,delta,deltaPct,unit,alert,error"]
    .concat(sorted.map((r) => [r.id, r.label, r.value ?? "", r.prevValue ?? "", r.delta ?? "", r.deltaPct?.toFixed(4) ?? "", r.unit ?? "", r.alert ?? "", r.error ?? ""]
      .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")))
    .join("\n");

  const htmlPath = join(outDir, `report-${tag}.html`);
  const csvPath = join(outDir, `report-${tag}.csv`);
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(csvPath, "\uFEFF" + csv, "utf8");
  return { htmlPath, csvPath };
}

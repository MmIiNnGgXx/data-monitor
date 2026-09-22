// 存储层:历史快照(JSONL,一行一次采集)—— 零依赖、可回溯、可直接 diff
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const fileOf = (dir, id) => join(dir, `${sanitize(id)}.jsonl`);
const sanitize = (s) => String(s).replace(/[^\w.-]+/g, "_").slice(0, 80);

/** 追加一条快照 */
export function append(dir, id, rec) {
  ensureDir(dir);
  appendFileSync(fileOf(dir, id), JSON.stringify(rec) + "\n", "utf8");
}

/** 读取历史(旧→新),limit 取最近 N 条 */
export function history(dir, id, limit = 0) {
  const f = fileOf(dir, id);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const arr = [];
  for (const l of lines) {
    try { arr.push(JSON.parse(l)); } catch { /* 跳过坏行,不让一条脏数据毁掉整份历史 */ }
  }
  return limit > 0 ? arr.slice(-limit) : arr;
}

/** 上一次的值(用于算变化) */
export function previous(dir, id) {
  const h = history(dir, id);
  return h.length ? h[h.length - 1] : null;
}

/** 简易统计:最近 N 次的均值/极值,用于做"异常检测" */
export function stats(dir, id, window = 30) {
  const vals = history(dir, id, window).map((r) => r.value).filter((v) => typeof v === "number");
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { n: vals.length, mean, sd, min: Math.min(...vals), max: Math.max(...vals) };
}

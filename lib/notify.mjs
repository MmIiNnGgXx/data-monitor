// 通知层 —— 出告警时主动找人,而不是等人来看报告
// 支持:企业微信机器人 / 钉钉机器人(含加签)/ 通用 Webhook / 邮件(SMTP,零依赖实现)
// 全部只用 Node 内置模块,不装任何包。

import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

/* ============================ 消息体 ============================ */
/**
 * 把一次采集结果整理成"人话"通知内容
 * @param {{title:string, results:Array, at:number}} run
 */
export function buildMessage(run) {
  const alerts = run.results.filter((r) => r.alert);
  const errors = run.results.filter((r) => r.error);
  const changed = run.results.filter((r) => r.changed === true || (r.delta != null && r.delta !== 0));

  const head = errors.length ? `🔴 ${errors.length} 项采集失败`
    : alerts.length ? `🟡 ${alerts.length} 项触发告警`
    : `🟢 ${changed.length} 项发生变化,无异常`;

  const lines = [];
  for (const r of errors.slice(0, 8)) lines.push(`❌ **${r.label}** 采集失败:${r.error}`);
  for (const r of alerts.slice(0, 8)) {
    const v = r.value == null ? "—" : `${r.value}${r.unit ? " " + r.unit : ""}`;
    const d = r.delta == null ? "" : `(${r.delta > 0 ? "+" : ""}${r.delta}${r.deltaPct != null ? `, ${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(2)}%` : ""})`;
    lines.push(`⚠️ **${r.label}** = ${v} ${d} — ${r.alert}`);
  }
  const rest = changed.filter((r) => !r.alert);
  for (const r of rest.slice(0, 5)) {
    const v = r.value == null ? "—" : `${r.value}${r.unit ? " " + r.unit : ""}`;
    lines.push(`• ${r.label} = ${v}${r.delta != null ? ` (${r.delta > 0 ? "+" : ""}${r.delta})` : r.changed ? " · 已变更" : ""}`);
  }
  if (!lines.length) lines.push("全部目标与上次持平。");

  const time = new Date(run.at).toLocaleString("zh-CN", { hour12: false });
  return {
    title: `数据监控 · ${head}`,
    text: [
      `**${run.title ?? "数据监控"}**`,
      head,
      "",
      ...lines,
      "",
      `时间:${time} ｜ 共 ${run.results.length} 个目标`,
    ].join("\n"),
    plain: [
      head,
      ...lines.map((l) => l.replace(/\*\*/g, "")),
      `时间:${time}`,
    ].join("\n"),
    summary: { alerts: alerts.length, errors: errors.length, changed: changed.length, total: run.results.length },
  };
}

/** 是否值得推送(全持平就不打扰用户) */
export function shouldNotify(msg, mode = "on-alert") {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return msg.summary.alerts > 0 || msg.summary.errors > 0;
}

/* ============================ HTTP 推送 ============================ */
const postJson = async (url, obj, headers = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(obj),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  // 企业微信/钉钉成功时也返回 200 + errcode,需要校验 body
  try {
    const j = JSON.parse(text);
    if (j.errcode != null && j.errcode !== 0) throw new Error(`errmsg: ${j.errmsg ?? text.slice(0, 80)}`);
  } catch (e) {
    if (e.message.startsWith("errmsg")) throw e;
  }
  return text.slice(0, 120);
};

/* ---- 企业微信群机器人 ---- */
async function sendWecom(ch, msg) {
  if (!ch.webhook) throw new Error("缺少 webhook");
  const content = [
    `## ${msg.title}`,
    "",
    ...msg.text.split("\n").slice(2),
  ].join("\n");
  return postJson(ch.webhook, { msgtype: "markdown", markdown: { content } });
}

/* ---- 钉钉群机器人(支持加签) ---- */
async function sendDingtalk(ch, msg) {
  if (!ch.webhook) throw new Error("缺少 webhook");
  let url = ch.webhook;
  if (ch.secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", ch.secret).update(`${ts}\n${ch.secret}`).digest("base64")
    );
    url += `&timestamp=${ts}&sign=${sign}`;
  }
  return postJson(url, {
    msgtype: "markdown",
    markdown: { title: msg.title, text: `### ${msg.title}\n\n${msg.text.split("\n").slice(2).join("\n")}` },
  });
}

/* ---- 通用 Webhook / Server酱 之类 ---- */
async function sendWebhook(ch, msg) {
  if (!ch.url) throw new Error("缺少 url");
  const body = ch.template === "serverchan"
    ? { title: msg.title, desp: msg.plain }
    : { title: msg.title, text: msg.text, summary: msg.summary, at: Date.now() };
  return postJson(ch.url, body, ch.headers ?? {});
}

/* ============================ 邮件(零依赖 SMTP) ============================ */
class SmtpSession {
  constructor(socket) { this.s = socket; this.buf = ""; this.waiter = null; this.closed = false; }
  _pump() {
    if (!this.waiter) return;
    const lines = this.buf.split("\r\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const consumed = lines.slice(0, i + 1).join("\r\n").length + 2;
        this.buf = this.buf.slice(consumed);
        const w = this.waiter; this.waiter = null;
        w.resolve(lines[i]);
        return;
      }
    }
  }
  expect() {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      const t = setTimeout(() => { if (this.waiter) { this.waiter = null; reject(new Error("SMTP 响应超时")); } }, 20000);
      const orig = resolve;
      this.waiter.resolve = (v) => { clearTimeout(t); orig(v); };
      this._pump();
    });
  }
  write(line) { this.s.write(line + "\r\n"); }
  async cmd(line, expectCode = "2") {
    this.write(line);
    const r = await this.expect();
    if (!r.startsWith(expectCode)) throw new Error(`SMTP ${line.split(" ")[0]} 失败: ${r}`);
    return r;
  }
}

/** 最小可用 SMTP 客户端:支持 465(隐式 TLS)与 587(STARTTLS),AUTH LOGIN */
async function sendEmail(ch, msg) {
  const { host, port = 465, secure = port === 465, user, pass, from, to } = ch;
  if (!host || !from || !to) throw new Error("邮件配置缺少 host / from / to");
  const toList = Array.isArray(to) ? to : String(to).split(/[,;]/).map((s) => s.trim()).filter(Boolean);

  const connect = () => new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const s = secure ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.setTimeout(20000, () => { s.destroy(new Error("SMTP 连接超时")); });
    s.on("error", reject);
  });

  let socket = await connect();
  let smtp = new SmtpSession(socket);
  let banner = await smtp.expect();
  if (!banner.startsWith("220")) throw new Error("SMTP 服务未就绪: " + banner);

  await smtp.cmd(`EHLO ${ch.helo ?? "localhost"}`, "2");

  if (!secure && ch.starttls !== false) {
    await smtp.cmd("STARTTLS", "2");
    socket = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket, servername: host }, () => resolve(t));
      t.on("error", reject);
    });
    smtp = new SmtpSession(socket);
    await smtp.cmd(`EHLO ${ch.helo ?? "localhost"}`, "2");
  }

  if (user && pass) {
    await smtp.cmd("AUTH LOGIN", "3");
    await smtp.cmd(Buffer.from(user).toString("base64"), "3");
    await smtp.cmd(Buffer.from(pass).toString("base64"), "2");
  }

  const domain = String(from).split("@")[1] ?? "localhost";
  await smtp.cmd(`MAIL FROM:<${from}>`, "2");
  for (const addr of toList) await smtp.cmd(`RCPT TO:<${addr}>`, "2");
  await smtp.cmd("DATA", "3");

  const subj = `=?UTF-8?B?${Buffer.from(msg.title, "utf8").toString("base64")}?=`;
  const body = msg.text.replace(/\*\*/g, "").replace(/\r?\n/g, "\r\n");
  const raw = [
    `From: ${from}`,
    `To: ${toList.join(", ")}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
    ".",
  ].join("\r\n");
  smtp.write(raw);
  const done = await smtp.expect();
  try { smtp.write("QUIT"); } catch {}
  try { socket.end(); } catch {}
  if (!done.startsWith("2")) throw new Error("邮件发送失败: " + done);
  return "sent";
}

/* ============================ 统一入口 ============================ */
const SENDERS = { wecom: sendWecom, dingtalk: sendDingtalk, webhook: sendWebhook, email: sendEmail };

/**
 * 按配置推送通知
 * @param {{channels?:Array, mode?:string}} notifyCfg
 * @param {object} run 采集结果
 * @returns {Promise<Array<{type,ok,error?}>>}
 */
export async function notify(notifyCfg, run) {
  const msg = buildMessage(run);
  const mode = notifyCfg?.mode ?? "on-alert";
  if (!shouldNotify(msg, mode)) return [{ type: "skip", ok: true, reason: "没有告警/失败,mode=" + mode }];

  const out = [];
  for (const ch of notifyCfg?.channels ?? []) {
    if (ch.disabled) { out.push({ type: ch.type, ok: true, reason: "已禁用" }); continue; }
    const fn = SENDERS[ch.type];
    if (!fn) { out.push({ type: ch.type, ok: false, error: `不支持的通知类型: ${ch.type}` }); continue; }
    try { await fn(ch, msg); out.push({ type: ch.type, ok: true }); }
    catch (e) { out.push({ type: ch.type, ok: false, error: e.message }); }
  }
  return out;
}

/** 测试推送(用假数据,便于配置后一键验证) */
export async function notifyTest(notifyCfg) {
  const fake = {
    at: Date.now(), title: "测试通知",
    results: [
      { id: "demo", label: "示例目标 A", value: 128, unit: "元", prevValue: 120, delta: 8, deltaPct: 6.67, alert: "环比 +6.67%" },
      { id: "demo2", label: "示例目标 B", value: "v2.0.0", prevValue: "v1.9.0", changed: true },
      { id: "demo3", label: "示例目标 C", value: null, error: "请求超时(15000ms)" },
    ],
  };
  const msg = buildMessage(fake);
  const out = [];
  for (const ch of notifyCfg?.channels ?? []) {
    if (ch.disabled) continue;
    const fn = SENDERS[ch.type];
    if (!fn) { out.push({ type: ch.type, ok: false, error: "不支持的类型" }); continue; }
    try { await fn(ch, msg); out.push({ type: ch.type, ok: true }); }
    catch (e) { out.push({ type: ch.type, ok: false, error: e.message }); }
  }
  return out;
}

export const CHANNEL_TYPES = Object.keys(SENDERS);

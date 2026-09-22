// 提取层:从抓到的内容里按配置取出"我们关心的那个值"
// 支持 4 种提取方式 —— 这决定了它能监控"任何公开数据",而不只是某一种接口

/**
 * @param {string} text  抓取到的原始文本
 * @param {object} spec  提取规则
 *   { type:'json',  path:'a.b.c' }        从 JSON 取字段
 *   { type:'regex', pattern:'...', group:1 } 用正则从 HTML/文本里抠
 *   { type:'length' }                     取内容长度(监控"页面是否变长/变短")
 *   { type:'text' }                       取全文(配合 hash 监控"页面是否改动")
 */
export function extractValue(text, spec) {
  if (!spec) return coerce(text.trim());

  switch (spec.type) {
    case "json": {
      let obj;
      try { obj = JSON.parse(text); }
      catch { throw new Error("配置为 json 提取,但返回不是 JSON"); }
      const v = pickPath(obj, spec.path);
      return coerce(v);
    }
    case "regex": {
      const re = new RegExp(spec.pattern, spec.flags ?? "s");
      const m = text.match(re);
      if (!m) return null;
      const raw = spec.group != null ? m[spec.group] : (m[1] ?? m[0]);
      return coerce(stripTags(raw));
    }
    case "length":
      return text.length;
    case "text":
      return text.trim();
    default:
      throw new Error(`未知的提取类型: ${spec.type}`);
  }
}

function pickPath(obj, path) {
  if (!path) return obj;
  return path.split(".").reduce((o, k) => {
    if (o == null) return undefined;
    const idx = Number(k);
    return Number.isInteger(idx) && Array.isArray(o) ? o[idx] : o[k];
  }, obj);
}

/** "1,234" / "12.5%" / "￥88" 这类都还原成数字,便于算变化 */
function coerce(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  const s = String(v).trim();
  const cleaned = s.replace(/[,\s￥$€£¥]/g, "").replace(/%$/, "");
  if (cleaned !== "" && !Number.isNaN(Number(cleaned))) return Number(cleaned);
  return s;
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** 文本内容的指纹,用于判断"页面是否被改过" */
export function fingerprint(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

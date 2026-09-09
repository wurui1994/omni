// 端到端回归：迷你模板引擎 + 日志解析。正则重（exec 循环、lastIndex、可选捕获、match(??)）、
// 字符串重（slice / trim / split / join / 模板）、Date（ISO 解析、getTime、NaN 判定）、
// 以及递归下降里那套"回退 out.length"的写法。
// 第四段真程序：迷你模板引擎 + 日志解析（正则重、字符串重、Date）
function compile(tpl) {
  const parts = [];
  let last = 0;
  const RE = /\{\{\s*([#\/]?)([\w.]+)\s*\}\}/g;
  let m;
  while ((m = RE.exec(tpl)) !== null) {
    if (m.index > last) parts.push({ k: "text", v: tpl.slice(last, m.index) });
    parts.push({ k: m[1] === "#" ? "open" : m[1] === "/" ? "close" : "var", v: m[2] });
    last = RE.lastIndex;
  }
  if (last < tpl.length) parts.push({ k: "text", v: tpl.slice(last) });
  return parts;
}
function lookup(ctx, path) {
  return path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), ctx);
}
function render(parts, ctx) {
  const out = [];
  let i = 0;
  const walk = (stopAt) => {
    while (i < parts.length) {
      const p = parts[i];
      if (p.k === "close") {
        if (p.v !== stopAt) throw new SyntaxError(`unexpected {{/${p.v}}}`);
        i++;
        return;
      }
      i++;
      if (p.k === "text") { out.push(p.v); continue; }
      if (p.k === "var") { const v = lookup(ctx, p.v); out.push(v === undefined ? "" : String(v)); continue; }
      // open: 循环或条件
      const start = i;
      const val = lookup(ctx, p.v);
      if (Array.isArray(val)) {
        const saveCtx = ctx;
        for (const item of val) { i = start; ctx = { ...saveCtx, ...(typeof item === "object" && item !== null ? item : { it: item }) }; walk(p.v); }
        ctx = saveCtx;
        if (val.length === 0) { i = start; const sink = out.length; walk(p.v); out.length = sink; }
      } else if (val) {
        walk(p.v);
      } else {
        const sink = out.length; walk(p.v); out.length = sink;
      }
    }
    if (stopAt !== null) throw new SyntaxError(`missing {{/${stopAt}}}`);
  };
  walk(null);
  return out.join("");
}
const tpl = "Hi {{user.name}}!\n{{#items}}- {{title}} ({{n}})\n{{/items}}{{#admin}}[admin]{{/admin}}done";
const ctx = { user: { name: "Ann" }, admin: false, items: [{ title: "a", n: 1 }, { title: "b", n: 2 }] };
console.log(render(compile(tpl), ctx));
console.log("---");
console.log(render(compile(tpl), { user: { name: "Bo" }, admin: true, items: [] }));
console.log("---");
for (const bad of ["{{#a}}x", "y{{/a}}"]) {
  try { render(compile(bad), {}); console.log("no-throw"); } catch (e) { console.log(`${e.name}: ${e.message}`); }
}
// 日志解析
const LOG = `
2021-03-04T05:06:07.008Z INFO  boot took 12ms
2021-03-04T05:06:08.100Z WARN  slow query 1500ms
2021-03-04T05:06:09.250Z ERROR db down
bad line here
2021-03-04T05:06:10.000Z INFO  retry 3
`;
const LINE = /^(\S+)\s+(INFO|WARN|ERROR)\s+(.*)$/;
const entries = [];
const bad = [];
for (const line of LOG.split("\n")) {
  const s = line.trim();
  if (!s) continue;
  const m = LINE.exec(s);
  if (!m) { bad.push(s); continue; }
  const t = new Date(m[1]);
  if (Number.isNaN(t.getTime())) { bad.push(s); continue; }
  entries.push({ at: t, level: m[2], msg: m[3], ms: (m[3].match(/(\d+)ms/) ?? [null, null])[1] });
}
console.log(entries.length, bad.length, bad.join("|"));
const byLevel = entries.reduce((acc, e) => { acc[e.level] = (acc[e.level] ?? 0) + 1; return acc; }, {});
console.log(JSON.stringify(byLevel));
const span = entries[entries.length - 1].at.getTime() - entries[0].at.getTime();
console.log(span, entries[0].at.toISOString(), entries.map((e) => e.ms ?? "-").join(","));
console.log(entries.filter((e) => e.level !== "INFO").map((e) => `${e.level}:${e.msg}`).join(" ; "));

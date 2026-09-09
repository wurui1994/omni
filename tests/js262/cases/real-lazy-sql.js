// 端到端回归：惰性序列管道 + 标签模板 SQL 构造器。生成器组合子（map/filter/take/scan/flatMap）、
// pipe、惰性（take 之后源不再被拉）、标签模板的 raw 与站点缓存身份、String.raw、转义。
// 生成器里的 for-of 从前是"先收齐再走"，这一段的 take 配无穷源直接挂住 —— 见 gen-forof-lazy.js。
// 第七段真程序：惰性序列管道 + 标签模板 SQL 构造器
const Seq = {
  *of(...xs) { yield* xs; },
  *range(a, b, step = 1) { for (let i = a; step > 0 ? i < b : i > b; i += step) yield i; },
  *map(it, f) { let i = 0; for (const v of it) yield f(v, i++); },
  *filter(it, p) { let i = 0; for (const v of it) if (p(v, i++)) yield v; },
  *take(it, n) { let k = 0; for (const v of it) { if (k++ >= n) return; yield v; } },
  *scan(it, f, seed) { let acc = seed; for (const v of it) { acc = f(acc, v); yield acc; } },
  *flatMap(it, f) { for (const v of it) yield* f(v); },
  reduce(it, f, seed) { let acc = seed; for (const v of it) acc = f(acc, v); return acc; },
  toArray(it) { return [...it]; },
};
const pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);
const nums = pipe(
  (it) => Seq.filter(it, (n) => n % 3 !== 0),
  (it) => Seq.map(it, (n, i) => n * n + i),
  (it) => Seq.take(it, 8),
)(Seq.range(1, 100));
console.log(Seq.toArray(nums).join(","));
console.log(Seq.toArray(Seq.scan(Seq.of(1, 2, 3, 4), (a, b) => a + b, 0)).join(","));
console.log(Seq.toArray(Seq.flatMap(Seq.range(1, 4), (n) => Seq.of(...Array.from({ length: n }, () => n)))).join(""));
console.log(Seq.reduce(Seq.range(10, 0, -2), (a, b) => a + "|" + b, "s"));
// 惰性：take 之后源不再被拉
let pulled = 0;
function* counted(n) { for (let i = 0; i < n; i++) { pulled++; yield i; } }
console.log(Seq.toArray(Seq.take(counted(100), 3)).join(","), pulled);
// 标签模板 SQL：参数化，标识符与值分开处理
function sql(strings, ...vals) {
  const params = [];
  let text = strings.raw[0];
  vals.forEach((v, i) => {
    if (v !== null && typeof v === "object" && v.raw !== undefined) text += String(v.raw);
    else { params.push(v); text += "$" + params.length; }
    text += strings.raw[i + 1];
  });
  return { text: text.replace(/\s+/g, " ").trim(), params };
}
const ident = (s) => ({ raw: /^[A-Za-z_]\w*$/.test(s) ? s : (() => { throw new SyntaxError(`bad ident ${s}`); })() });
const table = ident("users");
const min = 18;
const q = sql`
  select *
  from ${table}
  where age >= ${min} and name <> ${"o'brien"}
  order by ${ident("age")} desc
`;
console.log(q.text);
console.log(JSON.stringify(q.params));
try { ident("drop table"); } catch (e) { console.log(`${e.name}: ${e.message}`); }
// 同一处模板站点复用同一格 strings（缓存身份）
const seen = new Set();
const tag = (s) => { seen.add(s); return s.length; };
for (let i = 0; i < 3; i++) tag`a${i}b`;
console.log(seen.size);
// 转义与 raw
console.log(String.raw`a\nb\t${1}`, `a\nb`.length, "\u0041\x42\x43".length);

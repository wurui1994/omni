// 端到端回归：CSV -> 记录 -> 分组统计 -> 报表。私有字段、getter、生成器方法、Symbol.iterator、
// Map 分组、展开、解构、sort 的多键比较、padEnd/padStart、toFixed、JSON、以及三格报错。
// 第二段真程序：CSV -> 记录 -> 分组统计 -> 报表
class Table {
  #rows = [];
  #cols;
  constructor(cols) { this.#cols = [...cols]; }
  get columns() { return [...this.#cols]; }
  get size() { return this.#rows.length; }
  add(row) {
    if (row.length !== this.#cols.length) throw new RangeError(`expected ${this.#cols.length} cells, got ${row.length}`);
    const rec = {};
    this.#cols.forEach((c, i) => { rec[c] = row[i]; });
    this.#rows.push(rec);
    return this;
  }
  *[Symbol.iterator]() { for (const r of this.#rows) yield r; }
  groupBy(key) {
    const m = new Map();
    for (const r of this.#rows) {
      const k = String(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }
  static parse(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) throw new SyntaxError("empty csv");
    const [head, ...rest] = lines;
    const t = new Table(head.split(",").map((s) => s.trim()));
    for (const line of rest) {
      t.add(line.split(",").map((s) => {
        const v = s.trim();
        return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      }));
    }
    return t;
  }
}
const CSV = `
name, dept, salary, years
alice, eng, 120, 3
bob, eng, 95.5, 1
carol, sales, 88, 5
dave, sales, 102.25, 2
eve, ops, 77, 8
`;
const t = Table.parse(CSV);
console.log(t.columns.join("|"), t.size);
const byDept = t.groupBy("dept");
const stats = [...byDept.entries()]
  .map(([dept, rows]) => {
    const sal = rows.map((r) => r.salary);
    const total = sal.reduce((a, b) => a + b, 0);
    return {
      dept,
      n: rows.length,
      total: Number(total.toFixed(2)),
      avg: Number((total / rows.length).toFixed(2)),
      max: Math.max(...sal),
      names: rows.map((r) => r.name).sort().join("/"),
    };
  })
  .sort((a, b) => b.total - a.total || a.dept.localeCompare(b.dept));
for (const s of stats) {
  console.log(`${s.dept.padEnd(6)} n=${s.n} total=${String(s.total).padStart(7)} avg=${s.avg} max=${s.max} [${s.names}]`);
}
console.log(JSON.stringify(stats));
// 迭代协议、展开、解构
const [first, ...others] = t;
console.log(first.name, others.length, Object.keys(first).join(","));
// 报错那几格
const bad = [
  () => Table.parse(""),
  () => new Table(["a", "b"]).add([1]),
  () => t.groupBy("nope").size,
];
for (const f of bad) {
  try { console.log("ok " + f()); } catch (e) { console.log(`${e.name}: ${e.message}`); }
}
// Set / 去重 / 排序稳定性
const depts = new Set([...t].map((r) => r.dept));
console.log([...depts].join(","), depts.size);
const sorted = [...t].sort((a, b) => a.years - b.years).map((r) => r.name).join(",");
console.log(sorted);

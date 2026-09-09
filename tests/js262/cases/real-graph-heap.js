// 端到端回归：图 + Dijkstra + 最小堆 + 记忆化 + 数值格式化。私有字段、解构交换
// （[a[i],a[p]]=[a[p],a[i]]）、位移取父节点、Map/Set、可选链与 ??、多键比较器、递归 +
// Map 记忆化、toFixed/toExponential 的分档，以及三格报错。
// 第六段真程序：图 + Dijkstra + 记忆化 + 数值格式化
class MinHeap {
  #a = [];
  #cmp;
  constructor(cmp = (x, y) => x - y) { this.#cmp = cmp; }
  get size() { return this.#a.length; }
  push(v) {
    const a = this.#a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.#cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
    return this;
  }
  pop() {
    const a = this.#a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.#cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.#cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
class Graph {
  #adj = new Map();
  addEdge(a, b, w) {
    if (!(w > 0)) throw new RangeError(`weight must be positive, got ${w}`);
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!this.#adj.has(x)) this.#adj.set(x, []);
      this.#adj.get(x).push({ to: y, w });
    }
    return this;
  }
  get nodes() { return [...this.#adj.keys()].sort(); }
  neighbors(n) { return this.#adj.get(n) ?? []; }
  shortest(from) {
    if (!this.#adj.has(from)) throw new ReferenceError(`no node ${from}`);
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const seen = new Set();
    const h = new MinHeap((x, y) => x.d - y.d || (x.n < y.n ? -1 : x.n > y.n ? 1 : 0));
    h.push({ n: from, d: 0 });
    while (h.size > 0) {
      const { n, d } = h.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const { to, w } of this.neighbors(n)) {
        const nd = d + w;
        if (!dist.has(to) || nd < dist.get(to)) {
          dist.set(to, nd);
          prev.set(to, n);
          h.push({ n: to, d: nd });
        }
      }
    }
    return { dist, prev };
  }
  path(from, to) {
    const { dist, prev } = this.shortest(from);
    if (!dist.has(to)) return null;
    const out = [to];
    let cur = to;
    while (prev.has(cur)) { cur = prev.get(cur); out.push(cur); }
    return { cost: dist.get(to), path: out.reverse() };
  }
}
const g = new Graph();
[["a","b",4],["a","c",2],["b","c",5],["b","d",10],["c","e",3],["e","d",4],["d","f",11]]
  .forEach(([a, b, w]) => g.addEdge(a, b, w));
console.log(g.nodes.join(","));
for (const to of ["f", "d", "a", "zz"]) {
  const r = g.path("a", to);
  console.log(to, r === null ? "unreachable" : `${r.cost} via ${r.path.join("->")}`);
}
try { g.addEdge("x", "y", 0); } catch (e) { console.log(`${e.name}: ${e.message}`); }
try { g.shortest("nope"); } catch (e) { console.log(`${e.name}: ${e.message}`); }
// 记忆化 + 数值
const memo = new Map();
function fib(n) {
  if (n < 2) return n;
  if (memo.has(n)) return memo.get(n);
  const v = fib(n - 1) + fib(n - 2);
  memo.set(n, v);
  return v;
}
console.log([10, 20, 40, 78].map(fib).join(","), memo.size);
const fmt = (x) => (Math.abs(x) >= 1e6 ? x.toExponential(3) : x.toFixed(3));
console.log([1 / 3, 1e7 / 7, -0.0005, 2 ** 53].map(fmt).join(" | "));
// 堆的稳定性/边界
const h2 = new MinHeap();
[5, 3, 8, 1, 9, 2].forEach((x) => h2.push(x));
const drained = [];
while (h2.size > 0) drained.push(h2.pop());
console.log(drained.join(","), String(h2.pop()));

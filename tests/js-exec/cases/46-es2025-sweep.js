// 常写的 ES2020..ES2025 面各一小段，一次量六族（数值与串、对象与属性、类、解构与展开、
// 可选链与逻辑赋值、标签模板与正则）。这一格不是为某个新功能加的 —— 是**扫**出来的：
// 五条腿逐字节相同、并且与 qjs 也逐字节相同。它钉住的是"别人改动别处时不要悄悄弄坏这些"。
// 唯一从这份扫描里被摘掉的一行是 "ß".toUpperCase()：整张 Unicode 大小写表还没有，
// 那一格是**响错**（ADR-0020 的"要么整张表要么拒掉"），不是静静的错答案。
// 1 数值与串
console.log((1234.5678).toFixed(2), (0.000001234).toExponential(3), (255).toString(16));
console.log("abc".at(-1), "abc".padEnd(5, "*"), "a-b-c".replaceAll("-", "+"));
console.log([..."héllo"].length, "abc".toUpperCase(), "ABC".toLowerCase());
console.log(Number("0x1f"), Number(""), Number("  12  "), parseInt("08"), parseFloat(".5e1"));
console.log(0.1 + 0.2, 1e21, 1e-7, (-0).toString(), Object.is(-0, 0));
// 2 对象与属性
const o = { a: 1, get b() { return 2; }, ["c" + 1]: 3 };
console.log(Object.keys(o).join(","), JSON.stringify(o));
console.log(Object.getOwnPropertyNames(o).join(","), Object.entries(o).length);
const p = Object.create(o, { d: { value: 4, enumerable: true } });
console.log(p.a, p.d, "a" in p, Object.hasOwn(p, "a"));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(o, "a")));
// 3 类
class A { static s = 1; #x = 2; get x() { return this.#x; } static { A.t = 3; } }
console.log(A.s, A.t, new A().x);
class B extends A { constructor() { super(); this.y = 9; } toString() { return "B" + this.y; } }
console.log(String(new B()), new B() instanceof A);
// 4 解构与展开
const { a, ...rest } = { a: 1, b: 2, c: 3 };
console.log(a, JSON.stringify(rest));
const [x = 5, , z = 7] = [undefined, 2];
console.log(x, z);
const f = ({ m = 1, n: { q } = { q: 2 } } = {}) => m + q;
console.log(f(), f({ m: 10, n: { q: 20 } }));
// 5 可选链与逻辑赋值
let u = null; console.log(u?.a?.b, u?.[0], u?.());
let g1 = 0; g1 ||= 5; let g2 = 1; g2 &&= 6; let g3 = null; g3 ??= 7;
console.log(g1, g2, g3);
// 6 标签模板与正则
const tag = (s, ...v) => s.raw.join("|") + "#" + v.join(",");
console.log(tag`a${1}b${2}c`);
console.log("2020-01-02".replace(/(\d+)-(\d+)-(\d+)/, "$3/$2/$1"));
console.log([..."a1b2".matchAll(/[a-z](\d)/g)].map((m) => m[1]).join(""));
console.log(/(?<y>\d{4})/.exec("x2024").groups.y);

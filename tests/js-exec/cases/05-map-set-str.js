// Map / Set / 模块级状态 / 字符串与正则 / JSON
const m = new Map();
m.set("k", 1);
m.set(2, "two");
console.log(String(m.size));
console.log(String(m.get("k")));
console.log(String(m.get(2)));
console.log(String(m.get("nope")));
console.log(String(m.has(2)));
console.log(String(m.has("2")));
console.log([...m.keys()].join(","));
console.log([...m.values()].join(","));
for (const [k, v] of m) {
  console.log(`entry ${k}=${v}`);
}
console.log(String(m.delete("k")));
console.log(String(m.size));

const s = new Set();
s.add("x");
s.add(1);
s.add("x");
console.log(String(s.size));
console.log(String(s.has(1)));
let items = "";
for (const v of s) {
  items = items + v + ";";
}
console.log(items);

// 模块级状态：顶层函数读写同一个槽
let hits = 0;
const seen = new Map();
function record(key) {
  hits = hits + 1;
  if (seen.has(key)) {
    seen.set(key, seen.get(key) + 1);
    return false;
  }
  seen.set(key, 1);
  return true;
}
console.log(String(record("a")));
console.log(String(record("a")));
console.log(String(record("b")));
console.log(`hits=${hits} distinct=${seen.size}`);

// 字符串
const text = "Hello, Omni";
console.log(String(text.length));
console.log(text.toUpperCase());
console.log(text.slice(7));
console.log(text.slice(-4));
console.log(String(text.indexOf("Omni")));
console.log(String(text.includes("mni")));
console.log(String(text.startsWith("Hello")));
console.log(text.split(", ").join("|"));
console.log(String(text.charCodeAt(0)));
console.log("  pad  ".trim() + "!");
console.log("ab".repeat(3));
console.log(String("7".padStart(3, "0")));
console.log(String(text.at(-1)));
// charAt：越界是空串、负下标也是空串（和 .at() 正好相反）。asy 前端的 rootModName
// 就靠它一格一格往回找路径分隔符，从前不在成员表里，于是落到通用取属性上，
// 装好的那份一跑就 "string is not an object"。
console.log(`[${text.charAt(0)}][${text.charAt(4)}][${text.charAt(11)}][${text.charAt(-1)}]`);
console.log(`${text.charAt(0) === "H"} ${text.charAt(99) === ""} ${"".charAt(0) === ""}`);

// 对象当 Map/Set 的键：按**同一性**认。内容相同的两个对象是两个键，同一个对象取回来
// 还是那一格。asy 前端的 callAt / oiByNode / castByNode 都是拿语法树节点当键的，
// 从前这个值域里当场报 "cannot use a dict as a Map/Set key"。
const k1 = { n: 1 };
const k2 = { n: 1 };
const byObj = new Map();
byObj.set(k1, "one");
byObj.set(k2, "two");
console.log(`${byObj.size} ${String(byObj.get(k1))} ${String(byObj.get(k2))} ${String(byObj.get({ n: 1 }))}`);
byObj.set(k1, "again");
console.log(`${byObj.size} ${String(byObj.get(k1))}`);
// 键取回来是**原来那个对象**，不是号
let sum = 0;
for (const [k, v] of byObj) sum = sum + k.n + v.length;
console.log(String(sum));
// 数组、以及 Set 里的对象
const arrKey = [1, 2];
const objSet = new Set();
objSet.add(arrKey);
objSet.add([1, 2]);
objSet.add(arrKey);
console.log(`${objSet.size} ${String(objSet.has(arrKey))} ${String(objSet.has([1, 2]))}`);
// 字符串键仍然按内容认（同一性只管引用值）
const byStr = new Map();
byStr.set("a", 1);
byStr.set("a", 2);
console.log(`${byStr.size} ${String(byStr.get("a"))}`);

// 正则：字面量直接用在使用点上
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
console.log(String(IDENT.test("ok_1")));
console.log(String(IDENT.test("1no")));
console.log(String(/\d+/.test("x42")));
console.log("a1b22c".replace(/\d+/g, "#"));
console.log("a1b22c".split(/\d+/).join("|"));
console.log(String("a1b22c".match(/\d+/g).join(",")));
console.log(JSON.stringify({ n: 1, s: "x", arr: [true, null] }));
console.log(JSON.stringify([1, 2], undefined, 2));

// U+0000 是合法的字符串内容、也是合法的 Map 键（词法器的转义表里就有 '0' -> '\0' 这条）。
// C 侧的键规范化曾经用 printf 的 "%.*s" 拼标签前缀，%s 在第一个 NUL 处就停 —— "" 与
// "\u0000" 于是撞成同一个键，node 上却是两个。自举时表现为字面量池少一条、id 全体错位。
const nulKeys = new Map();
nulKeys.set("", "empty");
nulKeys.set("\u0000", "nul");
console.log(`${nulKeys.size} ${String(nulKeys.get(""))} ${String(nulKeys.get("\u0000"))}`);
console.log(`${"\u0000".length} ${String("\u0000" === "")} ${"a\u0000b".length}`);

// new Map(m) / new Set(s)：拿同类容器当初值的浅拷贝。编译器自己到处这么存一层作用域
// （hir/check.js、frontend-asy/lower.js、sexpr/lower.js 里三十多处），从前闭 ABI 的初值
// 只收 list，于是装好的那份一跑 asy 就 `dynamic value is Set, expected list`。
// 要验的是「拷出来的是另一个容器」：改副本不动原件。
const csrc = new Map();
csrc.set("a", 1);
csrc.set(2, "two");
const ccp = new Map(csrc);
ccp.set("a", 99);
ccp.set("new", 3);
console.log(`${csrc.size} ${String(csrc.get("a"))} ${String(csrc.get(2))} ${String(csrc.has("new"))}`);
console.log(`${ccp.size} ${String(ccp.get("a"))} ${String(ccp.get(2))} ${String(ccp.get("new"))}`);
console.log([...ccp.keys()].join(","));
const ss = new Set();
ss.add("x");
ss.add(7);
const sc = new Set(ss);
sc.add("y");
sc.delete("x");
console.log(`${ss.size} ${String(ss.has("x"))} ${String(ss.has("y"))}`);
console.log(`${sc.size} ${String(sc.has("x"))} ${String(sc.has(7))} ${String(sc.has("y"))}`);
// 空容器的拷贝、以及仍然收 list 的老路子
console.log(`${new Map(new Map()).size} ${new Set(new Set()).size}`);
console.log(`${new Map([["k", 1]]).size} ${new Set([1, 1, 2]).size}`);

// Set 的集合运算（ES2025）：次序是量点 —— intersection / isDisjointFrom 走小的那个，
// 别的以接收者为主。C 那份与 prelude 那份是对着写的，所以五条腿上必须逐字相同。
const su = new Set([5, 1, 9]);
const sv = new Set([9, 1, 7, 3, 5]);
console.log(`union ${[...su.union(sv)].join(",")} ${[...sv.union(su)].join(",")}`);
console.log(`inter ${[...su.intersection(sv)].join(",")} ${[...sv.intersection(su)].join(",")}`);
console.log(`diff ${[...su.difference(sv)].join(",")}| ${[...sv.difference(su)].join(",")}`);
console.log(`symdiff ${[...su.symmetricDifference(sv)].join(",")} ${[...sv.symmetricDifference(su)].join(",")}`);
console.log(`pred ${su.isSubsetOf(sv)} ${su.isSupersetOf(new Set([5]))} ${su.isDisjointFrom(new Set([2]))} ${su.isDisjointFrom(sv)}`);
console.log(`keep ${su.size} ${sv.size} ${[...new Set().union(su)].join(",")}`);

// 串模式的 replace（只换第一处）：替换可以是函数或带 $ 的串。C 那份借的是 re 那两格
// （omni_js_re_call / omni_js_re_sub），caps 现搭一格，所以这一行在 C 那条腿上也要量。
console.log(`rep ${"abc".replace("b", "X")} ${"abc".replace("z", "X")} ${"aab".replace("a", "-")}`);
console.log(`rep ${"abc".replace("b", (m) => m.toUpperCase())} ${"abc".replace("b", (m, i, s) => `${m}${i}${s}`)}`);
console.log(`rep ${"abc".replace("b", "[$&]")} ${"abc".replace("b", "$$")} ${"abc".replace("", "-")}`);
console.log(`rep ${"aXbXc".replaceAll(/X/g, "-")} ${"a1b2".replace(/\d/g, (m, i) => `${m}@${i}`)}`);

/* clear：整格清空、交出 undefined（规范 24.1.3.1 / 24.2.3.2）。C 那边容器模板里没有 clear，
   所以是"逐格摘掉"—— 摘完 size 要真是 0，之后还能照常再塞。 */
const cm = new Map([["a", 1], ["b", 2]]);
console.log(`clr ${cm.size} ${String(cm.clear())} ${cm.size} ${String(cm.get("a"))} ${cm.has("a")}`);
cm.set("c", 3);
console.log(`clr ${cm.size} ${String(cm.get("c"))} ${[...cm.keys()].join(",")}`);
const cs = new Set([1, 2, 3]);
console.log(`clr ${cs.size} ${String(cs.clear())} ${cs.size} ${cs.has(2)} ${cs.add(9).size} ${[...cs].join(",")}`);
// new Set(串)：按**码点**拆（从前只收 list，字符串当场报 "string is not an array"）
console.log(`sfs ${[...new Set("hello")].join("")} ${new Set("aab").size} ${new Set("").size}`);
/* entries（也是 for-of / 展开走的那一条）交出来的每一格是**新的**两元数组：内部存的那一格
   不能漏出去，不然往那一格上写就改到 Map 自己了。 */
const em = new Map([["a", 1]]);
const e1 = [...em];
const e2 = [...em];
console.log(`ent ${e1[0] === e2[0]} ${e1[0].join(":")}`);
e1[0][1] = 99;
console.log(`ent ${em.get("a")} ${[...em][0].join(":")} ${e1[0].join(":")}`);
for (const pair of em) { pair[0] = "zz"; }
console.log(`ent ${[...em.keys()].join(",")} ${em.has("a")}`);

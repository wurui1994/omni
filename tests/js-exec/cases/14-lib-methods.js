// P4 第一批库方法（ADR-0020）：flat / reduceRight / toSorted / replaceAll / padEnd。
// 这一条用例存在的理由是**验 C 那条腿** —— 每个方法都是"prelude 一份 + C 一份"，
// C 那份写坏了不会在 JS 后端上露出来，只有这里三条腿一起跑才会。
const nested = [1, [2, 3], [4, [5, [6]]]];
console.log(`flat1 ${JSON.stringify(nested.flat())}`);
console.log(`flat2 ${JSON.stringify(nested.flat(2))}`);
console.log(`flatInf ${JSON.stringify(nested.flat(Infinity))}`);
console.log(`flat0 ${JSON.stringify([[1], 2].flat(0))}`);

const xs = [1, 2, 3, 4];
console.log(`reduceR ${xs.reduceRight((a, b) => a + "," + b)}`);
console.log(`reduceR0 ${xs.reduceRight((a, b) => a + b, 100)}`);
console.log(`reduceRidx ${xs.reduceRight((a, b, i) => a + i, 0)}`);

const src = [3, 1, 2];
const sorted = src.toSorted((a, b) => a - b);
// toSorted 不动原数组，这一行是它和 sort 的分水岭
console.log(`toSorted ${JSON.stringify(sorted)} ${JSON.stringify(src)}`);
console.log(`toSortedDefault ${JSON.stringify([10, 9, 1].toSorted())}`);
// 比较器交出来的东西照规范先 ToNumber：交串的那种写法从前一律当 0，一格都不动
console.log(`sortStrCmp ${JSON.stringify([3, 1, 2].toSorted((x, y) => x < y ? "-1" : (x > y ? "1" : "0")))}`);
console.log(`sortUndef ${JSON.stringify([3, undefined, 1].toSorted((x, y) => x - y))}`);
/* 下标那一族的实参照规范走 ToIntegerOrInfinity（7.1.5）：先 ToNumber，NaN 当 0，其余截尾。
   串 / 布尔 / null 都收得下 —— 从前两条腿都当场报（"string index must be a number" /
   "fromIndex expects a number"）。 */
console.log(`idx ${"abcd".indexOf("c", "1")} ${"abcd".slice("1", "3")} ${"abcd".at("2")} ${"abcd".charAt("1")}`);
console.log(`idx ${[1, 2, 3].indexOf(2, "1")} ${[1, 2, 3].slice("1").join(",")} ${[1, 2, 3].at("2")} ${"a-b-c".split("-", "2").length}`);
// 空表 + 没给初值的 reduce 是能 catch 的 TypeError（规范 23.1.3.24 第 3 步）
function emptyReduce() {
  try { return `${[].reduce((s, x) => s + x)}`; } catch (e) { return `${e.name}:${e instanceof TypeError}`; }
}
console.log(`idx ${emptyReduce()} ${[].reduce((s, x) => s + x, 7)}`);
// Math.* 的实参照规范 ToNumber（从前两条腿都是严格标签检查、当场报）
console.log(`math ${Math.abs("-3")} ${Math.max("2", 1)} ${Math.trunc("-4.7")} ${Math.sqrt("9")}`);
console.log(`math ${Math.sign("-2")} ${Math.hypot("3", 4)} ${Math.pow("2", "3")} ${Math.min("5", 2)}`);

console.log(`replaceAll ${"a-b-c".replaceAll("-", "+")}`);
console.log(`replaceAll ${"aaa".replaceAll("aa", "b")}`);
console.log(`replaceAll ${"abc".replaceAll("", "-")}`);
console.log(`replaceAll ${"abc".replaceAll("x", "y")}`);

console.log(`padEnd ${"7".padEnd(4, "0")}|`);
console.log(`padEnd ${"7".padEnd(4)}|`);
console.log(`padEnd ${"abcd".padEnd(2, "0")}|`);
console.log(`padEnd ${"ab".padEnd(7, "xyz")}|`);

// at 在数组上：负下标从尾部数（a[-1] 走的是取属性那条路，给 undefined）
console.log(`at ${xs.at(0)} ${xs.at(-1)} ${xs.at(4)} ${xs.at(-9)} ${xs[-1]}`);

// clz32 与 parseFloat：C 那份都不是"转手 libm"，而是手写的（0 上的前导零、
// strtod 的 0x/inf 扩展要挡掉），所以两条腿都得量
console.log(`clz32 ${Math.clz32(0)} ${Math.clz32(1)} ${Math.clz32(0x80000000)} ${Math.clz32(-1)}`);
console.log(`clz32 ${Math.clz32(NaN)} ${Math.clz32(4294967297)}`);
console.log(`parseFloat ${parseFloat("1.5")} ${parseFloat(" 2.5e3xyz")} ${parseFloat("0x10")}`);
console.log(`parseFloat ${parseFloat("abc")} ${parseFloat("-Infinity")} ${Number.parseFloat(".5")}`);
console.log(`parseFloat ${parseFloat("3.")} ${parseFloat("1e")} ${parseFloat("1e+2")}`);

// JSON.parse 的 reviver：自底向上、键是字符串（数组是下标），返回 undefined 删格
const rev = JSON.parse('{"a":1,"b":{"c":2},"d":[3,4]}', (k, v) => (typeof v === "number" ? v + 10 : v));
console.log(`reviver ${JSON.stringify(rev)}`);
const drop = JSON.parse('{"a":1,"b":2}', (k, v) => (k === "b" ? undefined : v));
console.log(`reviver ${JSON.stringify(drop)}`);
const keys = [];
JSON.parse('{"a":[1]}', (k, v) => { keys.push(k); return v; });
console.log(`reviver ${keys.join("|")}`);
console.log(`reviver ${JSON.parse("[1,2]", (k, v) => v).join(",")}`);

// Error 那一家：name 是 $cls 链的头，catch/instanceof 顺着链认，cause 只在给了时才有
const te = new TypeError("t");
console.log(`err ${te.name} ${te.message} ${te instanceof TypeError} ${te instanceof Error}`);
console.log(`err ${new RangeError("r").name} ${new SyntaxError("s").name} ${new Error("e").name}`);
console.log(`err ${new Error("m", { cause: 1 }).cause} ${new Error("m").cause}`);
const ag = new AggregateError([te], "many");
console.log(`err ${ag.name} ${ag.message} ${ag.errors.length} ${ag instanceof Error}`);
try {
  throw new TypeError("thrown");
} catch (err) {
  console.log(`err ${err.name} ${err.message} ${err instanceof TypeError}`);
}

// Uint8Array 的下标读写：写进去只留低 8 位（300 & 255 = 44）
const ta = new Uint8Array(3);
ta[0] = 255;
ta[1] = 300;
console.log(`bytes ${ta[0]} ${ta[1]} ${ta[2]} ${ta.length}`);
ta[2] = ta[0] - 1;
console.log(`bytes ${ta[2]}`);
// new Uint8Array([…])：实参是数组就按元素填字节，每格照规范 ToNumber 再 ToUint8
// （截零、模 256、NaN 归 0）。数组与字节缓冲是两种值，"是哪一种"只有运行期知道，
// 所以降级器按标签在 js_buf_of_list 与 js_buf_view 之间挑。
const fromArr = new Uint8Array([256, -1, 1.7, NaN, "3", true, null, undefined]);
console.log(`bytes ${fromArr.length} ${fromArr[0]} ${fromArr[1]} ${fromArr[2]} ${fromArr[3]}`);
console.log(`bytes ${fromArr[4]} ${fromArr[5]} ${fromArr[6]} ${fromArr[7]} ${new Uint8Array([]).length}`);
// .set(src[, offset]) 与 .fill(v[, start[, end]])：从前这两格的 op 少一/两个形参，
// 成员派发器把多出来的实参**静静地丢了** —— set 写到 0 去、fill 把整格填满。
const dst = new Uint8Array(4);
dst.set(new Uint8Array([5, 6]), 2);
console.log(`bytes ${dst[0]} ${dst[1]} ${dst[2]} ${dst[3]}`);
const fl = new Uint8Array([1, 2, 3, 4]);
fl.fill(9, 1, 3);
console.log(`bytes ${fl[0]} ${fl[1]} ${fl[2]} ${fl[3]}`);
const fl2 = new Uint8Array([1, 2, 3, 4]);
fl2.fill(7, -2);
console.log(`bytes ${fl2[0]} ${fl2[1]} ${fl2[2]} ${fl2[3]} ${new Uint8Array(2).fill(1)[1]}`);
// JSON.stringify 的缩进照规范 25.5.2 第 4-6 步：**数**是那么多空格（最多 10）、
// **串**是它自己（最多前 10 个码元）、别的没有缩进。从前只认数，给串静静地印成一行。
console.log(JSON.stringify([1, [2]], null, "\t"));
console.log(JSON.stringify({ a: { b: 1 } }, null, 2));
console.log(JSON.stringify({ a: 1 }, null, "ab"), JSON.stringify({ a: 1 }, null, ""));
console.log(`gap ${JSON.stringify({ a: 1 }, null, 20).length} ${JSON.stringify({ a: 1 }, null, "0123456789xyz").split("\n")[1]}`);

// typeof 一个没声明的名字是 "undefined"，不是编译错（特性探测靠这一条）。
// 名字得是**哪儿都没有**的：structuredClone 那种在 node 里是函数，比不成。
function tf() {}
console.log(`typeof ${typeof noSuchGlobalAnywhere} ${typeof Math} ${typeof Map} ${typeof tf}`);
console.log(`typeof ${typeof undefined} ${typeof NaN} ${typeof ta} ${typeof "s"}`);

// DataView 的定宽那一族：ArrayBuffer/Uint8Array/DataView 在这个值域里是同一种值，
// 所以下面这几行看的是同一块内存（小端标志给不给都量一遍）
const dv = new DataView(new ArrayBuffer(8));
dv.setInt32(0, 7);
console.log(`dv ${dv.getInt32(0)} ${dv.getUint32(0)} ${dv.getInt8(3)}`);
dv.setInt32(0, -2, true);
console.log(`dv ${dv.getInt32(0, true)} ${dv.getUint32(0, true)} ${dv.getUint8(0)}`);
dv.setInt16(4, -1);
console.log(`dv ${dv.getInt16(4)} ${dv.getUint16(4)} ${dv.getInt8(4)}`);
dv.setUint16(4, 70000);
console.log(`dv ${dv.getUint16(4)}`);
dv.setFloat32(4, 0.5);
console.log(`dv ${dv.getFloat32(4)} ${dv.getFloat32(4, true)}`);
dv.setInt8(0, 200);
console.log(`dv ${dv.getInt8(0)} ${dv.getUint8(0)}`);

// WeakMap / WeakSet 就是 Map / Set：这个值域里没有可观测的回收，两者写不出区别
const wk = {};
const wm = new WeakMap();
wm.set(wk, 1);
console.log(`weak ${wm.get(wk)} ${wm.has(wk)} ${wm.has({})}`);
const ws = new WeakSet();
ws.add(wk);
console.log(`weak ${ws.has(wk)} ${ws.has({})} ${wm.delete(wk)} ${wm.has(wk)}`);

// ES2023：从后往前找那两格 + change-by-copy 的 toReversed / with（都拷一份再改）。
// 与上面几条同一个理由 —— C 那份写坏了只有在这条腿上跑才会露出来。
const cs = [1, 2, 3, 4];
console.log(`findLast ${cs.findLast((x) => x % 2 === 1)} ${cs.findLastIndex((x) => x % 2 === 1)}`);
console.log(`findLast ${[].findLast((x) => true)} ${[].findLastIndex((x) => true)}`);
console.log(`copy ${cs.toReversed().join(",")} ${cs.join(",")}`);
console.log(`copy ${cs.with(1, 9).join(",")} ${cs.with(-1, 0).join(",")} ${cs.join(",")}`);

// 成员调用里的展开与 concat 的可变实参：定长的派发器按下标取头几格，concat 摊成
// 一串调用（展开时是运行期 reduce）。C 那条腿上走的是 js_arr_at / js_arr_reduce。
console.log(`mspread ${cs.slice(...[1, 3]).join(",")} ${"abcdef".slice(...[1, 3])}`);
console.log(`mspread ${"a-b-c".split(...["-"]).join("|")} ${cs.indexOf(...[3])}`);
console.log(`mconcat ${[1, 2].concat([3], [4]).join(",")} ${[1, 2].concat(...[[3], [4]]).join(",")}`);
console.log(`mconcat ${"a".concat("b", "c")} ${"a".concat(...["b", "c"])} ${[].concat(...[]).length}`);

// Map.groupBy（ES2024）：回调只收两个实参（值、下标），每组按原顺序攒成数组。
// Object.groupBy 不在这儿 —— 它造的是真对象（null 原型），那一族在 C 那侧还没有。
const gm = Map.groupBy([1, 2, 3, 4], (x) => x % 2);
console.log(`groupBy ${[...gm.keys()].join(",")} ${gm.get(1).join(",")} ${gm.get(0).join(",")}`);
console.log(`groupBy ${Map.groupBy([], (x) => 1).size} ${Map.groupBy(["a"], (v, i, arr) => `${v}${i}${arr}`).size}`);

// isWellFormed / toWellFormed（ES2024）：C 那份是手划码元的，与 prelude 转手宿主的
// 那份必须给出同一套判据 —— 落单的代理项算不良，toWellFormed 把它替成 U+FFFD。
console.log(`wf ${"ab".isWellFormed()} ${"\ud800".isWellFormed()} ${"\ud800\udc00".isWellFormed()} ${"a\udfffb".isWellFormed()}`);
const wf = "\ud800x".toWellFormed();
console.log(`wf ${wf.length} ${wf.charCodeAt(0) === 0xfffd} ${"ab".toWellFormed()} ${"\ud800\udc00".toWellFormed().length}`);

// Uint8Array 可迭代（[...u8] / for-of / Array.from）：一格一个字节的数。
// C 那份走 omni_js_iter 里新加的 BYTES 那一支，所以这两行也要在五条腿上量。
const ub = new Uint8Array(3);
ub[0] = 1;
ub[1] = 2;
ub[2] = 255;
console.log(`iter ${[...ub].join(",")} ${Array.from(ub).length} ${Array.from(ub, (x) => x + 1).join(",")}`);
let usum = 0;
for (const byte of ub) usum = usum + byte;
console.log(`iter ${usum} ${[...new Uint8Array(0)].length}`);

// Uint8Array 上结果是原始值的那四格：先摊成字节的数组，再走 list 那一格。
// map / filter / slice 在 JS 里交出 TypedArray，摊成 list 会撒谎，所以那几个照旧当场报错。
console.log(`buf ${ub.join(",")} ${ub.join("|")} ${new Uint8Array(0).join(",")}|`);
console.log(`buf ${ub.at(0)} ${ub.at(-1)} ${ub.at(9)} ${ub.indexOf(2)} ${ub.indexOf(99)}`);
console.log(`buf ${ub.includes(255)} ${ub.includes(0)}`);

// fill 的 start/end 与 copyWithin：都在原地改，交出的还是同一格数组
const fa = [1, 2, 3, 4, 5];
console.log(`fill ${fa.fill(0, 3).join(",")} ${[1, 2, 3].fill(9, 1, 2).join(",")} ${[1, 2].fill(7).join(",")}`);
console.log(`fill ${[1, 2, 3].fill(8, -2).join(",")} ${[1, 2, 3, 4].fill(6, 1, -1).join(",")}`);
const cw = [1, 2, 3, 4, 5];
console.log(`cw ${cw.copyWithin(0, 3).join(",")} ${[1, 2, 3, 4, 5].copyWithin(1, 3, 4).join(",")}`);
console.log(`cw ${[1, 2, 3, 4, 5].copyWithin(-2, 0).join(",")} ${[1, 2, 3].copyWithin(0, 9).join(",")}`);
// Math.log2 / Math.sign（sign 的零那一格原样送回：Math.sign(-0) 是 -0）
console.log(`math ${Math.log2(8)} ${Math.log2(1)} ${Math.sign(-3)} ${Math.sign(0)} ${Math.sign(-0)} ${Math.sign(4)}`);
// String.raw 的普通调用形态（tag 形态在降级器那儿就折成字面量了）
console.log(`raw ${String.raw({ raw: ["x", "y"] }, 7)} ${String.raw({ raw: ["a"] })} ${String.raw({ raw: [] })}|`);
// JSON.stringify 的**数组** replacer（白名单）：只留名单里的键，按名单的次序
console.log(`json ${JSON.stringify({ b: 1, a: 2, c: 3 }, ["a", "b"])} ${JSON.stringify({ b: 1, a: 2 }, ["b", "a", "b"])}`);
console.log(`json ${JSON.stringify({ a: 1 }, ["zz"])} ${JSON.stringify([{ a: 1, b: 2 }], ["a"])}`);
// 四个 URI 全局函数：encodeURI 多留一族保留字符，decodeURI 反过来不换那一族
console.log(`uri ${encodeURIComponent("a b&c=d/e?f")} ${encodeURI("http://x.y/a b?c=d#g")}`);
console.log(`uri ${encodeURIComponent("héllo 日 𝒳")} ${decodeURIComponent("a%20b%26c")} ${decodeURI("a%20b%26c")}`);
console.log(`uri ${decodeURIComponent(encodeURIComponent("héllo 日 𝒳 %"))} ${encodeURIComponent(";/?:@&=+$,#")}`);
console.log(`uri ${encodeURIComponent("-_.!~*'()")} ${decodeURIComponent("%e6%97%a5")} ${encodeURIComponent(123)}|${encodeURIComponent("")}|`);

/* replaceAll 的**函数替换**与 $ 展开：从前 C 与 JS 两份都把替换一律当串（函数当场报错、
   $& 被当普通字符抄过去）。C 那份为此从 omni_js_str.c 搬进宏那一段，才用得上
   omni_js_re_sub / omni_js_re_call —— 与 replace 共用同一格 rep1。 */
console.log(`ra ${"x-y-z".replaceAll("-", (m) => "+")} ${"a1b1".replaceAll("1", (m, i) => i)}`);
console.log(`ra ${"a.b".replaceAll(".", "[$&]")} ${"ab".replaceAll("", "-")} ${"aa".replaceAll("a", "$$")}`);
console.log(`ra ${"abc".replace("b", (m) => m + m)} ${"abc".replace("b", "<$&>")}`);
// 全局的 isNaN / isFinite 先 ToNumber；Number 上那两格不转（各一格 op）
console.log(`nan ${isNaN("x")} ${isNaN("3")} ${isFinite("3")} ${isFinite("x")} ${isNaN(NaN)}`);
console.log(`nan ${Number.isNaN("x")} ${Number.isFinite("3")} ${isFinite(null)} ${isNaN(undefined)}`);
// endsWith 的第二格是**终点**、includes 的第二格是起点（两格从前都被丢掉了）；
// split 的分隔符不给时整串是一格
console.log(`pos ${"abc".endsWith("b", 2)} ${"abc".endsWith("c")} ${"abc".endsWith("b")} ${"abc".endsWith("a", 1)}`);
console.log(`pos ${"abcabc".includes("b", 2)} ${"abcabc".includes("b", 5)} ${"abc".startsWith("b", 1)}`);
console.log(`pos ${"abc".split().length} ${"abc".split(undefined)[0]} ${"a-b-c".split("-", 2).join(",")}`);
// join 的分隔符照规范 ToString（22.1.3.18 第 4 步）：只有**缺席**才是 ","，
// null 是 "null" 而不是报错（从前两侧都撞在 "null is not a string" 上）
console.log(`join ${[1, 2, 3].join(undefined)} ${[1, 2, 3].join(null)} ${[1, 2].join(0)}`);







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







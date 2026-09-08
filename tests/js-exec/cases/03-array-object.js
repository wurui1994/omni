// 数组与对象：字面量、下标、方法、for-of、展开、解构
const xs = [3, 1, 2];
console.log(String(xs.length));
console.log(String(xs[0]));
console.log(String(xs[9]));
xs.push(4);
console.log(xs.join(","));
console.log(xs.slice(1, 3).join(","));
console.log(String(xs.indexOf(2)));
console.log(String(xs.includes(9)));
console.log(xs.concat([7, 8]).join(","));

let total = 0;
for (const x of xs) {
  total = total + x;
}
console.log(`for-of total=${total}`);

let acc = "";
for (const ch of "héllo") {
  acc = acc + ch + ".";
}
console.log(acc);

const more = [0, ...xs, 9];
console.log(more.join(","));

const o = { a: 1, b: "two", "c-d": 3 };
console.log(String(o.a));
console.log(String(o.b));
console.log(String(o["c-d"]));
console.log(String(o.missing));
o.a = 10;
o["e"] = 5;
console.log(String(o.a + o.e));
console.log(Object.keys(o).join(","));
console.log(Object.values(o).join(","));
console.log(String("a" in o));
console.log(String(delete o.a));
console.log(Object.keys(o).join(","));

const nested = { list: [1, 2], inner: { deep: "yes" } };
console.log(String(nested.list[1]));
console.log(nested.inner.deep);
nested.list[0] = 100;
console.log(nested.list.join(","));

const [first, second, ...rest] = [10, 20, 30, 40];
console.log(`${first} ${second} ${rest.join("|")}`);
const { a: renamed, b } = { a: 1, b: 2 };
console.log(`${renamed} ${b}`);
const [withDefault = 5] = [];
console.log(String(withDefault));

let counter = 0;
counter += 5;
counter -= 2;
counter *= 3;
console.log(String(counter));
const box = { n: 1 };
box.n += 41;
console.log(String(box.n));
const arr2 = [1];
arr2[0] += 9;
console.log(String(arr2[0]));

let i = 0;
const post = i++;
const pre = ++i;
console.log(`post=${post} pre=${pre} i=${i}`);

let maybe = null;
maybe ??= "filled";
console.log(maybe);
let flag = 1;
flag ||= 99;
console.log(String(flag));
console.log(String(nested.nope?.deep));
// ?. 的短路是整条链的：nope 是 undefined，后面的 .list / .find / [0] 都不该发生
console.log(String(nested.nope?.list.find((x) => x > 0)));
console.log(String(nested.nope?.list[0]));
console.log(String(nested.nope?.list.join(",")));
console.log(String(nested.list?.find((x) => x > 1)));
console.log(String(JSON.stringify({ k: [1, "s", true, null] })));

// 数组身上挂字段：JS 里数组也是对象。asy 前端的 do-while 就往那一格更新列表上挂一个 dw
// （stmts.js 的 `ctx.dw = []`），从前这个值域里一读就 "dynamic value is list, expected dict"。
// 元素与属性互不干扰：length 只数元素，for-of 只走元素。
const withProp = [1, 2];
console.log(String(withProp.tag));
withProp.tag = "loop";
withProp.extra = [7];
console.log(`${withProp.tag} ${withProp.extra[0]} ${withProp.length}`);
withProp.push(3);
let propAcc = 0;
for (const v of withProp) propAcc = propAcc + v;
console.log(`${propAcc} ${withProp.length} ${withProp.join(",")}`);
console.log(String("tag" in withProp));
console.log(String(delete withProp.tag));
console.log(String(withProp.tag));
// 两个数组各自一份，互不串味
const a1 = [];
const a2 = [];
a1.mark = "one";
console.log(`${String(a1.mark)} ${String(a2.mark)}`);
// JSON 只看元素（宿主也是这样）
console.log(JSON.stringify(withProp));
/* delete 的键要按**串形**算（规范先 ToPropertyKey）：`delete d[1]` 里下标是个数 ——
   从前这一支落到"只收串"的 js_prop 上、当场报 "real is not a string"。
   数组下标那一格另说：`delete a[i]` 在 JS 里造洞，这个值域表达不出洞，所以它当场报
   （见 ADR-0020 与 prelude 的 $js_obj_delete）。 */
const numKeyed = {};
numKeyed[1] = 5;
numKeyed[2] = 6;
console.log(`${String(delete numKeyed[1])} ${JSON.stringify(numKeyed)}`);
// 长度之外的下标：什么都没删掉，但按规范给 true
const holey = [1, 2, 3];
console.log(`${String(delete holey[10])} ${holey.length} ${holey.join(",")}`);

// unshift：往头上插一格，回新长度（第一百〇四刀补的那格 ABI —— 编译器自己
// 往 `(main …)` 头上补一句时要它，而从前动态接收者上取 "unshift" 取到的是 undefined）
const uns = [2, 3];
console.log(`${uns.unshift(1)} ${uns.join(",")}`);
const uns0 = [];
console.log(`${uns0.unshift("a")} ${uns0.join(",")}`);

// in 在数组上：**元素那几格算键**（从前只问了旁表，0 in a 静静地给 false）
// Object.hasOwn 那几行在 tests/js262 里量 —— 它是 P1_JS_ONLY，摆进来整条用例会掉出 C 腿
const inA = [1, 2, 3];
console.log(`in ${0 in inA} ${2 in inA} ${3 in inA} ${"0" in inA} ${"length" in inA} ${"foo" in inA}`);
inA.foo = 1;
console.log(`in ${"foo" in inA} ${0 in []} ${"x" in { x: 1 }} ${"y" in { x: 1 }} ${1 in { 1: "a" }}`);
// void：算一遍再交出 undefined（副作用要留着）
let vo = 0;
console.log(`void ${String(void 0)} ${String(void (vo = 5))} ${vo}`);
console.log(`safe ${Number.isSafeInteger(3)} ${Number.isSafeInteger(2 ** 53)} ${Number.isSafeInteger(1.5)} ${Number.isSafeInteger("3")}`);

// a.length = n 是**改长度**（短了截掉、长了补 undefined），不是往数组身上挂一个字段
const la = [1, 2, 3, 4];
la.length = 2;
console.log(`len ${la.join(",")} ${la.length}`);
la.length = 4;
console.log(`len ${la.join(",")} ${la.length} ${String(la[3])}`);
la.length = 0;
console.log(`len ${la.join(",")}| ${la.length} ${JSON.stringify(la)}`);
const lb = [1, 2];
lb.foo = "x";
lb["length"] = 1;
console.log(`len ${lb.join(",")} ${lb.foo} ${lb.length}`);

/* splice / toSpliced / shift / keys / values / 非数组的 concat / Array(...) 的调用形态。
   实参个数是 splice 语义的一部分：splice(1) 删到底，而定长派发器会补 undefined、
   一格都不删 —— 所以这两格的实参整串摊成一格 list 交给 op（见 js_abi 的 js_arr_splice）。 */
const sp = [1, 2, 3, 4, 5];
console.log(`spl ${sp.splice(1, 2).join(",")} ${sp.join(",")} ${sp.splice(-1).join(",")} ${sp.join(",")}`);
const sp2 = [1, 2, 3];
console.log(`spl ${sp2.splice(1, 0, 9, 8).length}| ${sp2.join(",")} ${[1, 2, 3].splice(1).join(",")}`);
console.log(`spl ${[1, 2, 3].toSpliced(1, 1).join(",")} ${[1, 2, 3].toSpliced(1, 0, 9).join(",")}`);
console.log(`sh ${[1, 2].shift()} ${[].shift()} ${[...[1, 2, 3].keys()].join(",")} ${[...[4, 5].values()].join(",")}`);
console.log(`cat ${[1].concat([2], 3).join(",")} ${[1].concat("x").join(",")} ${Array(1, 2).join(",")}`);

/* 字面量里的求值次序（静默分叉那一族）：其中一格要 sink 时，它前面那些格先落进临时量。
   `{ x: a.splice(1,1).length, y: a.join(",") }` 里 join 从前跑在了 splice 前面；
   用过 sink 的那一格**自己的残留**也要落地，不然 `[m.set("a",1).size, …]` 第一格印的是
   后面那些 set 跑完之后的 size（两处都在 seq() 里）。 */
const eo = [1, 2, 3];
const ord = { x: eo.splice(1, 1).length, y: eo.join(",") };
console.log(`ord ${ord.x} ${ord.y}`);
const ea = [1, 2, 3];
console.log(`ord ${[ea.splice(1, 1).length, ea.join(",")].join("|")}`);
const em = new Map();
console.log(`ord ${[em.set("a", 1).size, em.size, em.set("b", 2).size].join(",")}`);
let cnt = 0;
function bump() { cnt++; return cnt; }
console.log(`ord ${[bump(), cnt, bump(), cnt].join(",")} ${JSON.stringify({ p: bump(), q: cnt })}`);

/* Map / Set 的 forEach 与 Set 的 entries / keys / values（回调收 (v, k, map) 与
   (v, v, set)），以及 Object.keys/values/entries 的**数组**那一支（下标先，旁表里的
   字符串键在后）。这几格从前都是运行期 "undefined is not a function" 或
   "list is not an object"。 */
const fm = new Map([["a", 1], ["b", 2]]);
const fmOut = [];
fm.forEach((v, kk, mm) => fmOut.push(`${kk}=${v}/${mm.size}`));
console.log(`fe ${fmOut.join(" ")}`);
const fs = new Set([3, 4]);
const fsOut = [];
fs.forEach((v, v2, ss) => fsOut.push(`${v}=${v2}/${ss.size}`));
console.log(`fe ${fsOut.join(" ")} ${[...fs.entries()].map((e) => e.join(":")).join(",")}`);
console.log(`fe ${[...fs.keys()].join(",")} ${[...fs.values()].join(",")}`);
console.log(`ok ${Object.keys([7, 8]).join(",")} ${Object.values([7, 8]).join(",")}`);
console.log(`ok ${JSON.stringify(Object.entries([7]))} ${Object.keys("ab").join(",")}`);
const okp = [1, 2];
okp.foo = "x";
console.log(`ok ${Object.keys(okp).join(",")} ${Object.values(okp).join(",")}`);

/* 没有声明的解构赋值（`[a] = xs` / `({x} = o)`）从前不收默认值、嵌套模式与计算键；
   现在与声明那边同一套（默认值只在 undefined 时用，嵌套再来一层）。
   对象字面量里展开**数组或字符串**抄的是它的自有可枚举键 —— 这一格 node 与规范一致，
   qjs 在字符串上给 {}（它自己的怪癖），所以字符串那一格只放在这条五腿用例里。 */
let da, db, dc;
[da = 1, [db = 2] = [], ...dc] = [undefined, [], 3, 4];
console.log(`de ${da} ${db} ${dc.join(",")}`);
let dx, dy;
({ dx, dy = 6 } = { dx: 5 });
console.log(`de ${dx} ${dy}`);
[dx, dy] = [dy, dx];
console.log(`de ${dx} ${dy}`);
const dkey = "kk";
const dobj = {};
({ [dkey]: dobj.got = 9 } = {});
console.log(`de ${dobj.got}`);
let dn1, dnRest;
({ p: { q: dn1 } = { q: 7 }, ...dnRest } = { z: 1 });
console.log(`de ${dn1} ${JSON.stringify(dnRest)}`);
console.log(`sp ${JSON.stringify({ ...[1, 2] })} ${JSON.stringify({ ..."ab" })} ${JSON.stringify({ ...{ a: 1 } })}`);
// indexOf / lastIndexOf / includes 的 fromIndex（负数从末尾数，越界夹住）—— 从前整格丢掉
console.log(`fi ${[1, 2, 3, 2].indexOf(2, 2)} ${[1, 2, 3, 2].indexOf(2, -2)} ${[1, 2, 3, 2].indexOf(2, 4)}`);
console.log(`fi ${[1, 2, 3, 2].lastIndexOf(2, 2)} ${[1, 2, 3, 2].lastIndexOf(2, 0)} ${[1, 2, 3, 2].lastIndexOf(2, -3)}`);
console.log(`fi ${[1, 2, 3].includes(2, 2)} ${[1, 2, 3].includes(2, -2)} ${[1, 2, 3].includes(3, 99)}`);
/* `[...a]` 必须是**一份新的**数组，`a.concat()` 也是。前者从前一段就交回去（js_iter 在 list
   上是恒等）—— `const b = [...a]` 拿到的就是 a 自己，`b.sort()` 把原数组也排了；后者缺席的
   实参补成 undefined，于是末尾多一格。两处都是 silent 的错答案。 */
const ali = [3, 1, 2];
const cp1 = [...ali];
cp1.push(9);
cp1.sort((x, y) => x - y);
console.log(`ali ${ali.join(",")} ${cp1.join(",")} ${ali === cp1}`);
const cp2 = ali.concat();
cp2.push(8);
console.log(`ali ${ali.length} ${cp2.join(",")} ${ali.concat(undefined).length}`);
const cp3 = [0, ...ali];
cp3[0] = 7;
console.log(`ali ${ali.join(",")} ${cp3.join(",")} ${[...ali, 4].join(",")}`);
const deep = [[1], [2]];
const cp4 = [...deep];
cp4[0].push(9);
console.log(`ali ${deep[0].join(",")} ${cp4.length} ${deep === cp4}`);
/* 下标形状的**字符串**键就是下标：往 "1" 上写与往 1 上写是同一格（规范里数组的 [[Set]]
   先把键 ToString、再看它是不是数组下标）。从前这一支落进旁表，那次写静静地丢了 ——
   读那一边一直是对的，所以更藏得住。 */
const sk = [1, 2, 3];
sk["1"] = 9;
sk["3"] = 4;
console.log(`sk ${sk.join(",")} ${sk.length} ${sk["1"]} ${sk[1]}`);
sk["01"] = "x";
sk.foo = "y";
console.log(`sk ${sk.length} ${Object.keys(sk).join(",")} ${sk["01"]} ${sk.foo}`);

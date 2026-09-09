// 具名捕获组与 exec/match 结果上的 index / input / groups（ADR-0020 P4/P5 的一角）。
//
// 两侧的引擎不是同一份：JS 那条腿借宿主 RegExp 当匹配原语，C 那条腿是手写回溯器
// （omni_js_re.c）—— 具名组是这一刀里在 C 那份的解析器上新加的，所以这条用例的价值
// 全在"五条腿逐字节相同"。结果 list 上的三格属性走的是 list 的旁表（xprops）。
const m = "2020-05".match(/(?<y>\d{4})-(?<mo>\d\d)/);
console.log(`m ${m[0]} ${m[1]} ${m[2]} ${m.length}`);
console.log(`m ${m.index} ${m.input} ${m.groups.y} ${m.groups.mo}`);

// 没有具名组时 groups 是 undefined（JS 就是这样）
const plain = "ab".match(/(a)(b)/);
console.log(`plain ${plain.length} ${plain.index} ${plain.groups}`);

// 组没参与匹配时那一格是 undefined，具名的那一格也是
const opt = "b".match(/(?<a>a)?b/);
console.log(`opt ${opt[0]} ${opt[1]} ${opt.groups.a} ${opt.index}`);

// exec 上同样挂着这三格；带 g 时 lastIndex 照旧推
const re = /(?<d>\d)/g;
const e1 = re.exec("x7y8");
console.log(`e ${e1[0]} ${e1.index} ${e1.groups.d} ${re.lastIndex}`);
const e2 = re.exec("x7y8");
console.log(`e ${e2[0]} ${e2.index} ${e2.groups.d} ${re.lastIndex}`);

// 带 g 的 .match 还是"所有整体匹配的字符串"，不带属性
const all = "aXbXc".match(/X/g);
console.log(`all ${all.length} ${all.join("|")} ${all.index}`);
console.log(`none ${"no".match(/z/)}`);

// matchAll 现在**五条腿都有**（ADR-0020 P1-c）：JS 那条腿交的是惰性迭代器对象，C 这条腿
// 交的是一条现摊好的 list —— for-of 与展开逐格相同（matchAll 有限、无副作用）。
const ma = [..."a1 b2".matchAll(/(\w)(\d)/g)];
console.log(`ma ${ma.length} ${ma[0][0]} ${ma[0].index} ${ma[1][1]} ${ma[1][2]}`);
for (const mm of "p1 q2".matchAll(/(?<L>\w)(?<D>\d)/g)) {
  console.log(`each ${mm[0]} ${mm.groups.L}${mm.groups.D} ${mm.index}`);
}
console.log(`empty ${[..."aaa".matchAll(/a*/g)].map((x) => x[0].length + "@" + x.index).join(",")}`);
console.log(`miss ${[..."no".matchAll(/z/g)].length}`);
let mag = "no-throw";
try {
  [..."x".matchAll(/x/)];
} catch (e) {
  mag = e instanceof TypeError ? "TypeError" : e.name;
}
console.log(`no-g ${mag}`);

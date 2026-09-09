// 回调里 throw 了，宿主那一份 op 的循环要**立刻停**。throw 在这个值域里是"放一格 pending
// 再跳"（ADR-0007 决定 1），所以每调一次回调之后都得问一句 pending —— 不问就是静默多跑
// 几圈。量出来的：forEach 在 node 上停在第二格，我们从前跑满三格。
// 解释器那两条腿另有一处：回调的 throw 落在解释器的待决槽里，而循环问的是 prelude 那一份，
// 两个槽要在边界上互搬（见 interp/builtin.js 的 invoke 与 mirrorPendingToHost）。
const seen = [];
try {
  [1, 2, 3].forEach((x) => { seen.push(x); if (x === 2) throw new Error("fe"); });
} catch (e) { console.log(`forEach ${e.message} ${seen.join(",")}`); }

const mapped = [];
try {
  [1, 2, 3].map((x) => { mapped.push(x); if (x === 2) throw new Error("mp"); return x; });
} catch (e) { console.log(`map ${e.message} ${mapped.join(",")}`); }

const kept = [];
try {
  [1, 2, 3].filter((x) => { kept.push(x); if (x === 2) throw new Error("fl"); return true; });
} catch (e) { console.log(`filter ${e.message} ${kept.join(",")}`); }

const asked = [];
try {
  [1, 2, 3].some((x) => { asked.push(x); if (x === 2) throw new Error("sm"); return false; });
} catch (e) { console.log(`some ${e.message} ${asked.join(",")}`); }

const each = [];
try {
  [1, 2, 3].every((x) => { each.push(x); if (x === 2) throw new Error("ev"); return true; });
} catch (e) { console.log(`every ${e.message} ${each.join(",")}`); }

const looked = [];
try {
  [1, 2, 3].find((x) => { looked.push(x); if (x === 2) throw new Error("fd"); return false; });
} catch (e) { console.log(`find ${e.message} ${looked.join(",")}`); }

const folded = [];
try {
  [1, 2, 3].reduce((acc, x) => { folded.push(x); if (x === 2) throw new Error("rd"); return acc + x; }, 0);
} catch (e) { console.log(`reduce ${e.message} ${folded.join(",")}`); }

const flatted = [];
try {
  [1, 2, 3].flatMap((x) => { flatted.push(x); if (x === 2) throw new Error("fm"); return [x]; });
} catch (e) { console.log(`flatMap ${e.message} ${flatted.join(",")}`); }

// 动态调用（`f()`，f 是形参）这一格：回调抛的是**宿主 op 自己**造的错（new Array(-1) 的
// RangeError），它先落在解释器的待决槽，makeClosure 的包装又把它抄进宿主那一份 —— 宿主那格
// 没人取就一直是脏的，catch 明明进去了，**后面某一句**才炸。所以边界上取回来一次
// （interp/builtin.js 的 jsCallFn）。量出来的：interp 上这一格之后 `new Array(2).length` 没了。
function caught(f) {
  try { f(); return "no-throw"; } catch (e) { return e.message; }
}
// RangeError 的**消息文本**两把尺子不一样（node 是 "Invalid array length"，qjs 是小写的
// "invalid array length"）—— 我们跟 qjs（js262 那道闸要求逐字节一致），所以这一格只量
// "抛没抛"，不量文本。
function threw(f) {
  try { f(); return "no"; } catch (e) { return "yes"; }
}
console.log(`dyn ${threw(() => new Array(-1))}`);
console.log(`after ${new Array(2).length}`);
console.log(`dyn2 ${caught(() => { throw new Error("own"); })} ${caught(() => 1)}`);

// 不抛的时候一格不变
console.log([1, 2, 3].map((x) => x * 2).join(","));
console.log(String([1, 2, 3].reduce((a, b) => a + b, 0)));
console.log(String([1, 2, 3].some((x) => x === 2)), String([1, 2, 3].every((x) => x > 0)));

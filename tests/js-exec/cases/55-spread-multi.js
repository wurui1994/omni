// 一次调用里**两个及以上展开**（ADR-0013 的实参表）。
//
// 从前这条路是坏的，而且坏得静默：实参表把 `{spread: 节点}` 这种包装交给 `seq`，
// 而 seq 为了保住求值次序会把待定的那几格提成临时量 —— 包装被当成表达式赋进临时量，
// spread 那一位就丢了。**一个**展开看不出来（它后面没有需要 sink 的东西），
// 两个才露出来：第二个展开要 sink，才触发前一个的提取。
// 量出来的两处红：tests/mir 的 `lower/cli.js`（"还没有处理的表达式 undefined"）与整条
// 自举链。判分的人是 node 自己，所以这一条以后不会再悄悄坏掉。

function count(a, ...xs) {
  let n = a;
  for (const x of xs) n = n + x;
  return n;
}

const o = { items: [1, 2] };
const ws = [3, 4];

// 两个展开，其中一个是**要 sink 的调用**（map）——正是那一格触发提取的形状
console.log(count(0, ...o.items, ...ws.map((w) => w + 1)));
// 三个展开，中间夹着普通实参
console.log(count(1, ...o.items, 10, ...ws, ...[100, 200]));
// 方法调用上的两个展开（接收者要留住）
class Box {
  constructor(base) { this.base = base; }
  sum(...xs) { return count(this.base, ...xs); }
}
const b = new Box(5);
console.log(b.sum(...o.items, ...ws));
// 求值次序：两个展开都带副作用，左到右
const log = [];
const push = (tag, arr) => { log.push(tag); return arr; };
console.log(count(0, ...push('a', [1]), ...push('b', [2])));
console.log(log.join(','));
// 展开在最前面（新数组那一条：不许把参数表交回给调用方的数组）
const src = [7, 8];
const got = Array.of(...src, ...ws);
got.push(9);
console.log(got.length, src.length, ws.length);

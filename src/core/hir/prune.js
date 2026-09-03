/**
 * 整程序摇树（第一百〇六刀）：只留下从入口可达的那些函数。
 *
 * 为什么需要：所有前端都是"把库整份降下来"。量出来的样子 —— `tests/asy/cases/01-arith.asy`
 * 44 行，进 C 后端的 OIR 里有 **1066 个函数**、发出来 **24200 行 C**。这 44 行用得到的只是
 * `write` 与几个算子（摇完 **142 个函数 / 4031 行**），其余全是 asy_builtins/settings 里
 * 从没被引到的东西。摇这一趟本身 **7ms**（走 12705 个对象）。
 *
 * 为什么按**字符串**找引用，而不是按节点种类：OIR 里"提到一个函数"的形式不止一种 ——
 * `(Call func)`、`(MakeClosure make)`、闭包描述子、类的方法表。逐种去认，将来加一种新节点
 * 就会漏掉一条边，而漏掉一条边的后果是**链接期未定义符号**，甚至是跑到一半才炸。
 * 所以这里反过来：把一个函数体的对象图里出现过的**所有字符串**收一遍，谁的符号名
 * （`f.mangled`）出现在里头就算被引到。代价是保守 —— 一句字符串常量刚好等于某个函数名
 * 就会把它留下来；那只是少摇掉一点，不会摇错。
 *
 * 根：入口函数，加上 funcs 之外那几格（structs/classes/enums/containers/boxDeeps/
 * closures/fnTypes）里提到的一切 —— 方法表和闭包描述子就在这些格子里。
 */

/**
 * 走一遍 x 的对象图，每见到一个字符串就喂给 hit。
 *
 * seen 是**整趟共用**的：类型图上有环（结构体字段指回自己），而且一份类型会被几百个函数
 * 引到 —— 每个函数各来一个 seen 就等于把类型图重走几百遍。共用是对的：走到的每个对象
 * 都属于某个**活的**函数（死函数压根不走），它的字符串谁先见到都一样喂进了 hit。
 *
 * 用 `Set` 而不是 `WeakSet`：这一趟走完 seen 就扔，弱引用一点用没有 —— 而这份代码要能被
 * **我们自己的 JS 前端**编译（`tests/mir` 的 `lower/cli.js`、`tests/bootstrap` 的不动点），
 * 那边还没有 WeakSet。第一版就是写成 WeakSet 才被那两条轴当场抓住的。
 */
function walkStrings(x, hit, seen) {
  const stack = [x];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') { hit(v); continue; }
    if (v === null || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const y of v) stack.push(y);
      continue;
    }
    for (const k of Object.keys(v)) stack.push(v[k]);
  }
}

/**
 * 摇树。**原地改** mod.funcs（后端拿到的就是摇过的那一份）。
 * @returns {{before:number, after:number}} 摇之前 / 之后的函数个数
 */
export function pruneFuncs(mod) {
  const funcs = mod.funcs;
  if (!Array.isArray(funcs) || funcs.length === 0) return { before: 0, after: 0 };
  // 一个符号名可能同时是 name 与 mangled（入口那份两格不同），两格都认。
  const byName = new Map();
  for (const f of funcs) {
    if (typeof f.mangled === 'string') byName.set(f.mangled, f);
    if (typeof f.name === 'string' && !byName.has(f.name)) byName.set(f.name, f);
  }
  const live = new Set();
  const wave = [];
  const seen = new Set();
  const reach = (nm) => {
    const f = byName.get(nm);
    if (f === undefined || live.has(f)) return;
    live.add(f);
    wave.push(f);
  };
  // 根一：入口。名字对不上就整份不摇 —— 宁可不省，也不能把入口摇掉。
  if (typeof mod.entry !== 'string' || !byName.has(mod.entry)) {
    return { before: funcs.length, after: funcs.length };
  }
  reach(mod.entry);
  // 根二：funcs 之外那几格里提到的函数（方法表、闭包描述子、容器助手…）
  for (const k of Object.keys(mod)) {
    if (k === 'funcs') continue;
    walkStrings(mod[k], reach, seen);
  }
  // 闭包到不动点
  while (wave.length > 0) walkStrings(wave.pop(), reach, seen);
  const before = funcs.length;
  const kept = funcs.filter((f) => live.has(f));
  mod.funcs = kept;
  return { before, after: kept.length };
}

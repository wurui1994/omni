/**
 * 区域作用域 —— **MIR 里"一个值在哪儿还能用"的那条规矩**。
 *
 * 这一格是撞出来的：`generic cse` 在 `src/runtime/omni_r3.c` 上把
 * `r3_num` 里的 `%38` 拿到循环之后去用，verifier 当场骂
 * 「%38 定义在一个已经关掉的区域里（支配关系不成立）」。
 *
 * 根因是**判据挑错了**：我按 CFG 的支配树判"能不能替"，而 MIR 的规矩比支配严 ——
 * `verify.js:124 checkRef` 判的是「定义它的那层区域此刻还在栈上吗」。
 * 循环之前的块**确实**支配循环之后的块（支配树上是祖先），但那个值在
 * `LOOP … END` 关掉之后就不可见了：结构化控制流里值活在区域里，
 * wasm 那条腿上它就是求值栈上的一格，END 一到就没了。
 *
 * 所以：**这一层的"支配"= 词法作用域 + 先后次序**，与 `verify.js` 那段逐字同构
 * （ELSE 会把 then 那层的 id 换掉，于是 then 里定义的值在 else 里不可见）。
 *
 * 结构化控制流里这两条加起来就是真的支配：同一层区域里不存在"往前跳过某条指令"的
 * 跳转（BR/BRIF 只往区域的 END 或循环头跳），所以"进了这层区域、又走到了 pcB"
 * 就意味着 pcA 执行过。
 */

import { OP } from '../ir.js';

/**
 * 回 `{regionOf, parent}`：
 *   `regionOf[pc]` —— 这条指令所在的最内层区域 id（0 = 函数体本身）
 *   `parent[id]`   —— 区域的父区域（`parent[0] = 0`，爬到它就停）
 *
 * 与 `verify.js:33 verifyFunc` 里那段**同一套 id 规则**（少了报错那一半）。
 */
export function regionScope(fn) {
  let next = 1;
  const parent = [0];
  const stack = [{ id: 0, op: null, hasElse: false }];
  const regionOf = [];
  for (let i = 0; i < fn.op.length; i++) {
    const op = fn.op[i];
    const top = stack[stack.length - 1];
    if (op === OP.ELSE && top.op === OP.IF && !top.hasElse) {
      /* then 里定义的 ref 在 else 里不可见：换一个新 id，父亲照旧 */
      top.hasElse = true;
      const nid = next++;
      parent[nid] = parent[top.id];
      top.id = nid;
    } else if (op === OP.END && stack.length > 1) {
      stack.pop();
    }
    regionOf.push(stack[stack.length - 1].id);
    if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) {
      const id = next++;
      parent[id] = stack[stack.length - 1].id;
      stack.push({ id, op, hasElse: false });
    }
  }
  return { regionOf, parent };
}

/**
 * `pcDef` 定义的值在 `pcUse` 那儿**用得上吗**（= verifier 会不会骂）。
 * 判据：`pcDef < pcUse` 且 `pcDef` 那层区域在 `pcUse` 的开区域链上。
 */
export function inScope(sc, pcDef, pcUse) {
  if (pcDef >= pcUse) return false;
  const want = sc.regionOf[pcDef];
  let r = sc.regionOf[pcUse];
  for (let guard = 0; guard <= sc.parent.length; guard++) {
    if (r === want) return true;
    if (r === 0) return false;
    r = sc.parent[r];
    if (r === undefined) return false;
  }
  return false;
}

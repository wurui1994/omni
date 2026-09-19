/**
 * MIR 的 CFG —— 把结构化控制流的标记摊成基本块（ADR-0039 的前置）。
 *
 * MIR 里控制流是 wasm 那套标记（`mir/ir.js` 的第 2 条决策）：
 * `BLOCK/LOOP/IF/ELSE/END` + `BR/BRIF`（按往外数第几层跳）。优化通道要的是块与边，
 * 所以这一格把标记**翻成 label/goto**，再切基本块。
 *
 * 跳转语义照 wasm（也就是照 MIR 自己的注释）：
 *   - 跳到 `BLOCK` = 跳到它的 `END` **之后**（break）
 *   - 跳到 `LOOP`  = 回到**循环头**（continue）
 *   - `IF` 条件假 ⇒ 去它的 `ELSE` 之后；没有 ELSE 就去 `END` 之后
 *   - `ELSE` 本身是 then 段的出口 ⇒ 无条件跳到 `END` 之后
 *   - `END` 对控制流是空操作（wasm 的 LOOP 不自动重来，要重来得自己 `br`）
 *
 * 这一层**不改 fn**，只读出结构 —— 所以任何通道都能拿它算支配树/活跃性，
 * 而"改图"由各通道自己负责（改完重新 build 一次）。
 */

import { OP, OP_NAMES, opensRegion } from '../ir.js';

/** 一条指令是不是控制流的终结子（它之后必然开一个新块）。
 *  `BRTABLE` 也在里头 —— 少了它，`switch` 的 CFG 就是**错的**：
 *  表里那些目标拿不到入边、BRTABLE 那一块还多出一条"顺序落下去"的边。
 *  这个洞是 `tests/c/gen/10-switch.c` 抓出来的（mem2reg 按错的单前驱传了值，s=7457 变 7557）。 */
function isTerm(op) {
  return op === OP.BR || op === OP.BRIF || op === OP.RET
      || op === OP.IF || op === OP.ELSE || op === OP.BRTABLE;
}

/**
 * 配对扫描：每个 BLOCK/LOOP/IF 的 `END` 在哪儿、IF 的 `ELSE` 在哪儿（没有就是 -1）。
 * 回 `{endOf, elseOf}`，下标是开区域那条指令的 pc。
 */
export function matchRegions(fn) {
  const n = fn.op.length;
  const endOf = new Array(n).fill(-1);
  const elseOf = new Array(n).fill(-1);
  const stack = [];
  for (let pc = 0; pc < n; pc++) {
    const op = fn.op[pc];
    if (opensRegion(op)) {
      stack.push(pc);
    } else if (op === OP.ELSE) {
      if (stack.length === 0) throw new Error(`mir/cfg: %${pc} ELSE 不在 IF 里`);
      const open = stack[stack.length - 1];
      if (fn.op[open] !== OP.IF) throw new Error(`mir/cfg: %${pc} ELSE 配的不是 IF`);
      elseOf[open] = pc;
    } else if (op === OP.END) {
      if (stack.length === 0) throw new Error(`mir/cfg: %${pc} END 没有配对的区域`);
      endOf[stack.pop()] = pc;
    }
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new Error(`mir/cfg: %${open} ${OP_NAMES[fn.op[open]]} 没有 END`);
  }
  return { endOf, elseOf };
}

/**
 * `BR/BRIF aux=depth` 打算跳到哪个 pc。
 * `openStack` 是当前未闭合的区域（pc 数组，栈顶是最内层）。
 */
function brTarget(fn, openStack, depth, endOf, atPc) {
  const idx = openStack.length - 1 - depth;
  if (idx < 0) throw new Error(`mir/cfg: %${atPc} BR 层数 ${depth} 超出了当前区域深度`);
  const open = openStack[idx];
  const op = fn.op[open];
  if (op === OP.LOOP) return open;          // continue：回循环头
  return endOf[open] + 1;                   // break：END 之后
}

/**
 * 把 fn 切成基本块。
 * 回 `{blocks, entry, pcBlock}`：
 *   blocks[i] = { id, from, to, succ:[], pred:[] }（`from..to` 含首尾，是指令 pc 区间）
 *   pcBlock[pc] = 这条指令属于哪个块（-1 = 不可达/没归块）
 */
export function buildCfg(fn) {
  const n = fn.op.length;
  const m = matchRegions(fn);
  const endOf = m.endOf, elseOf = m.elseOf;

  /* ---- 第一遍：算每条指令的跳转目标（label/goto 形），顺便收集 leader ---- */
  // jmpA[pc] = 无条件/条件为真时去哪儿（-1 = 没有）
  // jmpB[pc] = 条件为假时去哪儿（-1 = 顺序执行下一条）
  const jmpA = new Array(n).fill(-1);
  const jmpB = new Array(n).fill(-1);
  /* jmpT[pc] = 跳表的全部目标（含兜底）。只有 BRTABLE 有，别人是 null。 */
  const jmpT = new Array(n).fill(null);
  const isLeader = new Array(n + 1).fill(false);
  isLeader[0] = true;

  const openStack = [];
  for (let pc = 0; pc < n; pc++) {
    const op = fn.op[pc];
    if (opensRegion(op)) openStack.push(pc);
    else if (op === OP.END) openStack.pop();

    if (op === OP.BR) {
      jmpA[pc] = brTarget(fn, openStack, fn.aux[pc], endOf, pc);
    } else if (op === OP.BRIF) {
      jmpA[pc] = brTarget(fn, openStack, fn.aux[pc], endOf, pc);
      jmpB[pc] = pc + 1;
    } else if (op === OP.IF) {
      jmpA[pc] = pc + 1;                                   // 真 ⇒ then 段
      jmpB[pc] = elseOf[pc] >= 0 ? elseOf[pc] + 1 : endOf[pc] + 1;
    } else if (op === OP.ELSE) {
      // then 段走到这儿就该出去；ELSE 所属的 IF 是**刚刚**压回栈的那个
      const open = openStack[openStack.length - 1];
      jmpA[pc] = endOf[open] + 1;
    } else if (op === OP.RET) {
      jmpA[pc] = n;                                        // n = 出口
    } else if (op === OP.BRTABLE) {
      /* 跳表（ADR-0017 第三刀）：b 是层数池（**层数，不是 ref**），aux 是兜底层数。 */
      const outs = [];
      for (const lv of fn.levelsOf(fn.b[pc])) outs.push(brTarget(fn, openStack, lv, endOf, pc));
      outs.push(brTarget(fn, openStack, fn.aux[pc], endOf, pc));
      jmpT[pc] = outs;
      for (const t of outs) isLeader[t <= n ? t : n] = true;
    }

    if (jmpA[pc] >= 0) isLeader[jmpA[pc] <= n ? jmpA[pc] : n] = true;
    if (jmpB[pc] >= 0) isLeader[jmpB[pc] <= n ? jmpB[pc] : n] = true;
    // LOOP 是跳转落点（`br` 回头），它自己就是 leader
    if (op === OP.LOOP) isLeader[pc] = true;
    if (isTerm(op) && pc + 1 <= n) isLeader[pc + 1] = true;
  }

  /* ---- 第二遍：按 leader 切块 ---- */
  const blocks = [];
  const pcBlock = new Array(n).fill(-1);
  let cur = -1;
  for (let pc = 0; pc < n; pc++) {
    if (isLeader[pc] || cur < 0) {
      cur = blocks.length;
      blocks.push({ id: cur, from: pc, to: pc, succ: [], pred: [] });
    }
    blocks[cur].to = pc;
    pcBlock[pc] = cur;
  }
  if (blocks.length === 0) return { blocks, entry: -1, pcBlock };

  /* ---- 第三遍：连边。看每个块最后一条指令 ---- */
  const blockAt = (pc) => (pc >= n ? -1 : pcBlock[pc]);
  const addEdge = (fromId, toPc) => {
    const to = blockAt(toPc);
    if (to < 0) return;                    // 落到出口
    if (blocks[fromId].succ.indexOf(to) < 0) blocks[fromId].succ.push(to);
    if (blocks[to].pred.indexOf(fromId) < 0) blocks[to].pred.push(fromId);
  };
  for (const bb of blocks) {
    const last = bb.to;
    const op = fn.op[last];
    if (op === OP.RET) continue;                       // 到出口，没有后继
    if (jmpT[last] !== null) {                         // 跳表：只有表里那些目标
      for (const t of jmpT[last]) addEdge(bb.id, t);
      continue;
    }
    if (jmpA[last] >= 0) addEdge(bb.id, jmpA[last]);
    if (jmpB[last] >= 0) addEdge(bb.id, jmpB[last]);
    if (jmpA[last] < 0 && jmpB[last] < 0) addEdge(bb.id, last + 1);   // 顺序落下去
  }

  return { blocks, entry: 0, pcBlock, jmpA, jmpB, jmpT, endOf, elseOf };
}

/** 从入口能到的块（不可达的块后面 deadcode 那格会删）。 */
export function reachable(cfg) {
  const seen = new Set();
  if (cfg.entry < 0) return seen;
  const work = [cfg.entry];
  while (work.length > 0) {
    const b = work.pop();
    if (seen.has(b)) continue;
    seen.add(b);
    for (const s of cfg.blocks[b].succ) work.push(s);
  }
  return seen;
}

/**
 * 支配树（Cooper-Harvey-Kennedy 的迭代法）。
 * 回 `idom` 数组：`idom[b]` = b 的直接支配者（入口是自己）。
 * 为什么用这个算法：实现二十行、对我们这种块数（几十到几百）比 Lengauer-Tarjan 快，
 * 而且**不需要**先做 DFS 编号之外的任何预处理。
 */
export function dominators(cfg) {
  const nb = cfg.blocks.length;
  const idom = new Array(nb).fill(-1);
  if (nb === 0) return idom;

  // 逆后序（RPO）
  const order = [];
  const seen = new Array(nb).fill(false);
  const stack = [[cfg.entry, 0]];
  seen[cfg.entry] = true;
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const b = top[0];
    if (top[1] < cfg.blocks[b].succ.length) {
      const s = cfg.blocks[b].succ[top[1]];
      top[1]++;
      if (!seen[s]) { seen[s] = true; stack.push([s, 0]); }
    } else {
      order.push(b);
      stack.pop();
    }
  }
  order.reverse();                       // 现在是 RPO
  const rpoNum = new Array(nb).fill(-1);
  for (let i = 0; i < order.length; i++) rpoNum[order[i]] = i;

  idom[cfg.entry] = cfg.entry;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of order) {
      if (b === cfg.entry) continue;
      let newIdom = -1;
      for (const p of cfg.blocks[b].pred) {
        if (idom[p] < 0) continue;       // 还没算出来
        if (newIdom < 0) { newIdom = p; continue; }
        // intersect(p, newIdom)
        let a = p, c = newIdom;
        while (a !== c) {
          while (rpoNum[a] > rpoNum[c]) a = idom[a];
          while (rpoNum[c] > rpoNum[a]) c = idom[c];
        }
        newIdom = a;
      }
      if (newIdom >= 0 && idom[b] !== newIdom) { idom[b] = newIdom; changed = true; }
    }
  }
  return idom;
}

/** 支配边界（Cytron 的算法，插 phi 用）。 */
export function domFrontiers(cfg, idom) {
  const nb = cfg.blocks.length;
  const df = [];
  for (let i = 0; i < nb; i++) df.push([]);
  for (let b = 0; b < nb; b++) {
    const preds = cfg.blocks[b].pred;
    if (preds.length < 2) continue;
    for (const p of preds) {
      let runner = p;
      while (runner >= 0 && runner !== idom[b]) {
        if (df[runner].indexOf(b) < 0) df[runner].push(b);
        if (idom[runner] === runner) break;      // 入口
        runner = idom[runner];
      }
    }
  }
  return df;
}

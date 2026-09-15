// Omni stage0 — 语法表的构造（ADR-0014 决策 2）
//
// ## 为什么是 LALR(1)（从 SLR(1) 升上来的，2026-09）
//
// 先前这一格是 SLR(1)，理由写得也对：有了 GLR，构表期没解决的冲突留到运行期分叉解决，
// 而 **SLR 与 LALR 接受的语言在 GLR 驱动下完全相同** —— 差别只是"错误的那支什么时候死"，
// 不是"有没有合法的分析树"。所以那时的结论是"精度换来的只是速度，真嫌慢了再升级，
// 位置就在这一个文件里"。
//
// **现在就是那个时候，而且逼上来的不是速度，是能不能用。** 量出来的：
//
//   - POSIX awk 那份语法（ext/awk/awk.grammar）在 SLR 下剩 **608 处**冲突，702 份语料
//     只过 33 份 —— 失败几乎全是 `too many concurrent parses (> 400)` 与
//     `the input is ambiguous`。GLR 驱动器不是在"帮忙"，是在替表干活，然后被淹掉。
//   - 同一门语言，gawk 自己那份照 yacc 的 LALR 写的 `awkgram.y`，过我们的导入器建表
//     只剩 **58 处**。差一个数量级。
//
// 差的就是一句话：**SLR 的 FOLLOW 是全局的**。它把"这个非终结符在整份语法里能被什么
// 跟着"当成"它在**这一处**能被什么跟着"。表达式语言里同一个非终结符出现在十几处，
// 这个近似就把十几处的 FOLLOW 全糊在一起 —— 每一处都多出一堆假的归约动作。
//
// 升级的落点很小（这也是当初那句"位置就在这一个文件里"兑现的地方）：项集族那一趟
// 一个字没改，只把"归约铺哪些记号"从 `FOLLOW(左部)` 换成 `lalrLookaheads` 算出来的
// 那一格。见那个函数的注释。
//
// ## 优先级
//
// 移进/归约冲突先用优先级判（bison 的规矩，照抄）：产生式优先级高就归约，终结符高就移进，
// 同级看结合性，`nonassoc` 两个都删掉（那就是"这么写非法"）。**任何一边没有优先级就两个都留**，
// 交给 GLR。归约/归约冲突一律留着 —— 优先级管不了它，bison 那边是按规则序号硬选一个，
// 我们让分析器去试。

import { rulePrecOf } from './grammar.js';

const ACCEPT = '$accept';
const END = '$end';

/** 可空集合与 FIRST。都是不动点迭代 —— 语法就这么大，不值得为它写更聪明的算法。 */
function firstSets(g) {
  const nullable = new Set();
  const first = new Map();
  for (const nt of g.nonterms.keys()) first.set(nt, new Set());
  for (;;) {
    let changed = false;
    for (const r of g.rules) {
      const f = first.get(r.lhs);
      let allNullable = true;
      for (const s of r.rhs) {
        if (g.terms.has(s)) {
          if (!f.has(s)) { f.add(s); changed = true; }
          allNullable = false;
          break;
        }
        for (const x of first.get(s)) {
          if (!f.has(x)) { f.add(x); changed = true; }
        }
        if (!nullable.has(s)) { allNullable = false; break; }
      }
      if (allNullable && !nullable.has(r.lhs)) { nullable.add(r.lhs); changed = true; }
    }
    if (!changed) break;
  }
  return { nullable, first };
}

/** 一串符号的 FIRST，外加"整串可空时把 tail 也算进来" */
function firstOfSeq(g, ns, seq, tail) {
  const out = new Set();
  for (const s of seq) {
    if (g.terms.has(s)) { out.add(s); return out; }
    for (const x of ns.first.get(s)) out.add(x);
    if (!ns.nullable.has(s)) return out;
  }
  for (const x of tail) out.add(x);
  return out;
}

function followSets(g, ns) {
  const follow = new Map();
  for (const nt of g.nonterms.keys()) follow.set(nt, new Set());
  follow.get(g.start).add(END);
  for (;;) {
    let changed = false;
    for (const r of g.rules) {
      for (let i = 0; i < r.rhs.length; i++) {
        const s = r.rhs[i];
        if (!g.nonterms.has(s)) continue;
        const add = firstOfSeq(g, ns, r.rhs.slice(i + 1), follow.get(r.lhs));
        const f = follow.get(s);
        for (const x of add) {
          if (!f.has(x)) { f.add(x); changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  return follow;
}

const itemKey = (r, dot) => `${r}.${dot}`;
/* 项是一串 `"规则号.点位"`（这个形状进了缓存的表文本，所以不能改）。拆它的地方有四处，
   全走这两条而不是 `it.split('.')`：**量出来的** —— native 那趟 GLR 建表里
   `split` 每次要新分配一个两格的列表加两段子串，而这四处合起来一趟要跑几十万遍
   （/usr/bin/sample 的榜上 omni_list_dynamic_from 106、omni_js_arr_i 108 就是它）。
   indexOf + slice 少两次列表分配。回的数与 split 那条路一模一样，所以表逐字节不变。 */
const itemRule = (it) => Number(it.slice(0, it.indexOf('.')));
const itemDot = (it) => Number(it.slice(it.indexOf('.') + 1));

/** LR(0) 闭包：点后面是非终结符就把它的产生式都拉进来 */
function closure(g, kernel) {
  const items = new Set(kernel);
  const work = [...kernel];
  while (work.length > 0) {
    const it = work.pop();
    const dot = itemDot(it);
    const r = g.rules[itemRule(it)];
    const s = r.rhs[dot];
    if (s === undefined || !g.nonterms.has(s)) continue;
    for (const ri of g.nonterms.get(s).rules) {
      const k = itemKey(ri, 0);
      if (!items.has(k)) { items.add(k); work.push(k); }
    }
  }
  return items;
}

/** 传播用的假前看记号。它只在 LALR 那一趟里流动，不会进表。 */
const DUMMY = '#la';

/**
 * **带前看集的** LR(1) 闭包。`seed` 是 `Map<项, Set<记号>>`，答同样形状的 Map（含闭进来的）。
 *
 * 与上面那个 LR(0) 闭包的差别只有一句：拉 `B -> ·γ` 进来时，它的前看集是
 * `FIRST(点后面剩下那串 · 本项的前看集)`。这一句就是 LALR 与 SLR 的全部分歧 ——
 * SLR 用的是 `FOLLOW(B)`（不看上下文），这里用的是**这一处**点后面那串。
 */
function closure1(g, ns, seed) {
  const la = new Map();
  const work = [];
  const add = (k, toks) => {
    let s = la.get(k);
    if (s === undefined) { s = new Set(); la.set(k, s); }
    let grew = false;
    for (const t of toks) {
      if (!s.has(t)) { s.add(t); grew = true; }
    }
    if (grew) work.push(k);
  };
  for (const [k, toks] of seed) add(k, toks);
  while (work.length > 0) {
    const it = work.pop();
    const ri = itemRule(it);
    const dot = itemDot(it);
    const r = g.rules[ri];
    const B = r.rhs[dot];
    if (B === undefined || !g.nonterms.has(B)) continue;
    const tail = firstOfSeq(g, ns, r.rhs.slice(dot + 1), la.get(it));
    for (const rj of g.nonterms.get(B).rules) add(itemKey(rj, 0), tail);
  }
  return la;
}

/**
 * LALR(1) 的前看集（Aho/Sethi/Ullman 的"自发生成 + 传播"那套，算法 4.63）。
 *
 * 为什么非要它：从前这一格用的是 SLR(1)（归约照 `FOLLOW(左部)` 铺满一行）。SLR 的
 * FOLLOW 是**全局**的 —— 它把"这个非终结符在整份语法里能被什么跟着"当成"它在**这一处**
 * 能被什么跟着"。量出来的代价：POSIX awk 那份语法在 SLR 下剩 608 处冲突，GLR 驱动器
 * 当场炸（`too many concurrent parses`），而同一门语言 gawk 那份照 LALR 写的 .y 只有 58 处。
 * 差一个数量级，差的就是这一格。
 *
 * 算法三步，都在项集族**已经建好之后**跑（所以 LR(0) 那一趟一个字没改）：
 *
 *   1. **核项**：每个状态里点不在最左的那些项（0 号状态另加 `$accept -> ·S`）。
 *      前看集只对核项算 —— 别的项是闭包拉进来的，它们的前看集由核项算得出来（第 3 步）。
 *   2. **自发生成与传播**：对每个核项做一次 `closure1`，种子的前看集是**一格假记号** `#la`。
 *      闭包里凡是"点后面是 X"的项，都在 `goto(状态, X)` 那边对应一个核项：
 *        - 前看集里是真记号 a ⇒ a 在那边**自发生成**（与本项的前看集无关）；
 *        - 前看集里是 `#la` ⇒ 本项的前看集要**传播**过去（画一条边，最后迭代到不动点）。
 *      `$accept -> ·S` 的前看集初始化成 `{$end}` —— 整套的唯一源头。
 *   3. **铺回全项**：每个状态拿核项的前看集再做一次 `closure1`，得到**所有**项的前看集。
 *      这一步不是多余的：空产生式那些项（`A -> ·`）点在最左、不是核项，而它们恰恰要归约。
 *
 * 答 `full[状态号] = Map<项, Set<记号>>`。
 */
function lalrLookaheads(g, ns, states, rules, acceptRule) {
  const kernels = [];
  for (let i = 0; i < states.length; i++) {
    const ks = [];
    for (const it of states[i].items) {
      if (itemDot(it) > 0 || (i === 0 && itemRule(it) === acceptRule)) ks.push(it);
    }
    kernels.push(ks);
  }

  const la = new Map();
  const cell = (s, it) => `${s}#${it}`;
  for (let i = 0; i < states.length; i++) {
    for (const it of kernels[i]) la.set(cell(i, it), new Set());
  }
  la.get(cell(0, itemKey(acceptRule, 0))).add(END);

  /* 传播边：`from -> [to…]`。一条边就是"这两格的前看集必须一样多"。 */
  const edges = new Map();
  for (let i = 0; i < states.length; i++) {
    for (const it of kernels[i]) {
      const seed = new Map();
      seed.set(it, new Set([DUMMY]));
      for (const [jt, toks] of closure1(g, ns, seed)) {
        const ri = itemRule(jt);
        const dot = itemDot(jt);
        const X = rules[ri].rhs[dot];
        if (X === undefined) continue;
        const to = states[i].trans.get(X);
        if (to === undefined) continue;
        const tk = cell(to, itemKey(ri, dot + 1));
        const dst = la.get(tk);
        if (dst === undefined) continue;
        for (const t of toks) {
          if (t !== DUMMY) { dst.add(t); continue; }
          const fk = cell(i, it);
          if (!edges.has(fk)) edges.set(fk, []);
          edges.get(fk).push(tk);
        }
      }
    }
  }

  for (;;) {
    let changed = false;
    for (const [from, tos] of edges) {
      const src = la.get(from);
      for (const to of tos) {
        const dst = la.get(to);
        for (const t of src) {
          if (!dst.has(t)) { dst.add(t); changed = true; }
        }
      }
    }
    if (!changed) break;
  }

  const full = [];
  for (let i = 0; i < states.length; i++) {
    const seed = new Map();
    for (const it of kernels[i]) seed.set(it, la.get(cell(i, it)));
    full.push(closure1(g, ns, seed));
  }
  return full;
}

/**
 * 规范项集族。产生的表：
 *   states[i] = {items: string[], actions: Map<term, Action[]>, gotos: Map<nonterm, number>}
 *   Action = {kind:'shift', to} | {kind:'reduce', rule} | {kind:'accept'}
 */
export function buildTable(g) {
  const a = augment(g);
  const gg = a.gg;
  const rules = a.rules;
  const acceptRule = a.acceptRule;
  const follow = a.follow;

  const states = [];
  const byKey = new Map();
  const intern = (kernel) => {
    const items = [...closure(gg, kernel)].sort();
    const key = items.join(' ');
    const found = byKey.get(key);
    if (found !== undefined) return found;
    const id = states.length;
    byKey.set(key, id);
    /* `trans` 是"这个状态在某个符号上走到哪儿"—— 终结符那半与 actions 里的 shift 重复，
       但 LALR 那一趟要按**符号**查（不分终结符/非终结符），单开一格比查两处清楚。 */
    states.push({ items, actions: new Map(), gotos: new Map(), trans: new Map() });
    return id;
  };

  intern([itemKey(acceptRule, 0)]);
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    // 按"点后面的那个符号"分组，每组一个后继状态
    const groups = new Map();
    for (const it of st.items) {
      const ri = itemRule(it);
      const dot = itemDot(it);
      const s = rules[ri].rhs[dot];
      if (s === undefined) continue;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(itemKey(ri, dot + 1));
    }
    for (const [s, kernel] of groups) {
      const to = intern(kernel);
      st.trans.set(s, to);
      if (gg.terms.has(s)) addAction(st, s, { kind: 'shift', to });
      else st.gotos.set(s, to);
    }
  }

  // 归约与接受。前看集是 **LALR(1)** 的（不是 FOLLOW）—— 见 lalrLookaheads 的注释。
  const look = lalrLookaheads(gg, a.ns, states, rules, acceptRule);
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    for (const it of st.items) {
      const ri = itemRule(it);
      const dot = itemDot(it);
      const r = rules[ri];
      if (dot !== r.rhs.length) continue;
      if (ri === acceptRule) { addAction(st, END, { kind: 'accept' }); continue; }
      const toks = look[i].get(it);
      if (toks === undefined) continue;
      for (const t of toks) addAction(st, t, { kind: 'reduce', rule: ri });
    }
  }

  const conflicts = resolveConflicts(gg, states, rules);
  return {
    grammar: g, states, rules, acceptRule, conflicts,
    first: a.ns.first, follow, nullable: a.ns.nullable,
  };
}

/**
 * 构表**之外**的那一半：增广文法、产生式表、FIRST/FOLLOW。
 * 分出来是因为缓存要它 —— 从磁盘读回状态表时这一半是现算的（量过一共 5ms，而
 * 项集族那一半是 780ms），于是「缓存里存什么」这个问题只剩状态表与冲突清单。
 */
function augment(g) {
  // 增广：`$accept -> start`。归约它就是接受，所以它不进 rules，单独认。
  const acceptRule = g.rules.length;
  const rules = [...g.rules, { lhs: ACCEPT, rhs: [g.start], action: null, prec: null, prefer: 0, span: null }];
  // `new Map(x)` 落到 `js_map_of_pairs`，它现在**也收 Map**（浅拷贝），所以这里就是
  // 一句拷贝。从前手写一遍循环，是因为闭 ABI 的初值只收"成对的列表"—— node 上照跑，
  // 原生构建里当场报 "dynamic value is Map, expected list"（量出来的：自举链阶段 9）。
  // 这一刀是把那条界往回收：不该由方言的窄处决定源码怎么写。
  const nonterms = new Map(g.nonterms);
  // 字段手写，不用 `{...g, ...}`：dict 的展开在原生构建里要走一条动态路径，而这里
  // 需要的字段就这几个。多写一行换掉一处不必要的动态性。
  const gg = { name: g.name, terms: g.terms, nonterms, rules, start: g.start, prec: g.prec };
  gg.nonterms.set(ACCEPT, { name: ACCEPT, rules: [acceptRule] });

  const ns = firstSets(gg);
  const follow = followSets(gg, ns);
  follow.set(ACCEPT, new Set([END]));
  return { acceptRule, rules, gg, ns, follow };
}

function addAction(st, t, a) {
  if (!st.actions.has(t)) st.actions.set(t, []);
  const list = st.actions.get(t);
  for (const x of list) {
    if (x.kind === a.kind && x.to === a.to && x.rule === a.rule) return;
  }
  list.push(a);
}

/**
 * 冲突处理。返回留下来的冲突清单（构表期解决掉的不算）—— 那份清单是给人看的：
 * 它说明这份语法在哪些地方要靠运行期分叉，也就是慢在哪里。
 */
function resolveConflicts(g, states, rules) {
  const out = [];
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    for (const [t, list] of st.actions) {
      if (list.length < 2) continue;
      const shift = list.find((a) => a.kind === 'shift');
      const reduces = list.filter((a) => a.kind === 'reduce');
      if (shift !== undefined && reduces.length > 0) {
        // 逐个把归约和那一个移进比一遍（bison 的规矩）。任何一次比不出来，两边都留。
        const tp = g.prec.get(t);
        let keepShift = false;
        const kept = [];
        for (const r of reduces) {
          const rp = rulePrecOf(g, rules[r.rule]);
          if (tp === undefined || rp === null) { kept.push(r); keepShift = true; continue; }
          if (rp.level > tp.level) { kept.push(r); continue; }
          if (rp.level < tp.level) { keepShift = true; continue; }
          if (tp.assoc === 'left') { kept.push(r); continue; }
          if (tp.assoc === 'right') { keepShift = true; continue; }
          // nonassoc：同级又不结合，就是"这么写非法"，两边都删掉
        }
        const next = keepShift ? [shift, ...kept] : kept;
        st.actions.set(t, next);
        if (next.length !== 1) {
          out.push({ state: i, token: t, kind: next.length === 0 ? 'nonassoc' : 'shift/reduce', actions: next.length });
        }
        continue;
      }
      // 归约/归约：优先级管不了，留给 GLR
      out.push({ state: i, token: t, kind: 'reduce/reduce', actions: list.length });
    }
  }
  return out;
}

/**
 * 稳定的文本形态，给测试快照用。刻意只印"有动作的"那些格子。
 * `brief` 时跳过每个状态的项集与动作表 —— 真实语言的语法有几百个状态，全印出来是
 * 半兆文本，进仓库不合适，而回归真正要盯的是**产生式表与剩下的冲突**那两段。
 */
export function dumpTable(tb, brief = false) {
  const lines = [];
  const sym = (s) => s;
  lines.push(`grammar ${tb.grammar.name}: ${tb.grammar.terms.size} terminals, ${tb.grammar.nonterms.size} nonterminals, ${tb.grammar.rules.length} rules, ${tb.states.length} states`);
  for (let i = 0; i < tb.rules.length; i++) {
    const r = tb.rules[i];
    // 印出 prefer：它不影响表，但它影响运行期定胜负，快照要能看住它
    const tail = r.prefer === undefined || r.prefer === 0 ? '' : `   [prefer ${r.prefer}]`;
    lines.push(`  r${i}  ${r.lhs} -> ${r.rhs.length === 0 ? '<empty>' : r.rhs.map(sym).join(' ')}${tail}`);
  }
  for (let i = 0; i < tb.states.length && !brief; i++) {
    const st = tb.states[i];
    lines.push(`state ${i}`);
    for (const it of st.items) {
      const ri = itemRule(it);
      const dot = itemDot(it);
      const r = tb.rules[ri];
      // 点插在第 dot 个符号前面。刻意不写 `parts.splice(dot, 0, '.')`：splice 不在封闭
      // ABI 里，node 上照跑，原生构建里当场报 "dynamic value is list, expected dict"。
      const parts = [];
      for (let k = 0; k < r.rhs.length; k++) {
        if (k === dot) parts.push('.');
        parts.push(sym(r.rhs[k]));
      }
      if (dot >= r.rhs.length) parts.push('.');
      lines.push(`  item ${r.lhs} -> ${parts.join(' ')}`);
    }
    for (const t of [...st.actions.keys()].sort()) {
      const acts = st.actions.get(t).map((a) => (a.kind === 'shift' ? `shift ${a.to}` : a.kind === 'accept' ? 'accept' : `reduce r${a.rule}`));
      lines.push(`  on ${sym(t)}: ${acts.join(' | ')}`);
    }
    for (const nt of [...st.gotos.keys()].sort()) lines.push(`  goto ${nt}: ${st.gotos.get(nt)}`);
  }
  if (tb.conflicts.length > 0) {
    lines.push(`conflicts left to the GLR driver: ${tb.conflicts.length}`);
    for (const c of tb.conflicts) lines.push(`  state ${c.state} on ${sym(c.token)}: ${c.kind} (${c.actions} actions)`);
  } else {
    lines.push('conflicts left to the GLR driver: none (this grammar is LALR(1))');
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ 表的缓存
 *
 * 构表是这条路上唯一的慢步：asy 那份语法 433 个状态，量过 **780ms 全在项集族那一遍**
 * （FIRST/FOLLOW 4ms、归约 6ms、冲突 5ms、读语法 20ms）。而测试轴一条 case 一次进程，
 * 一条轴上百次 —— 不缓存就是白烧几分钟。
 *
 * 存的只有**状态表与剩下的冲突清单**：产生式表、FIRST/FOLLOW、增广文法都是从语法现算的
 * （augment，5ms），于是缓存文件里没有一处引用语法树的节点 —— 不用序列化 span、动作模板
 * 那些东西，格式因此小而稳。
 *
 * 格式是**按行的整数**，不是 JSON：`JSON.parse` 不在封闭 ABI 里（ADR-0011 决策 2 ——
 * 只有 stringify），而 `split` 在。符号名各占一行（字面量终结符的名字是 JSON.stringify
 * 出来的，里面不会有真的换行），别处一律是它们的下标。
 *
 *   glr-table <版本> <状态数> <符号数>
 *   <符号 0> … <符号 n-1>          每个一行
 *   i <item> <item> …              项集（`规则号.点位` 原样，读回去就是它）
 *   a <符号号>:<动作>,<动作> …      动作：s<到>/r<规则>/a
 *   g <符号号>:<到> …              goto
 *   C <冲突数>
 *   <状态> <符号号> <种类> <动作数>
 */

/** 缓存格式的版本。序列化的形状改了就加一 —— 缓存键里带着它，老文件自动失效。 */
export const TABLE_FORMAT = 2;

/** 表 -> 缓存文本 */
export function tableText(tb) {
  const syms = [];
  const idx = new Map();
  const sym = (s) => {
    const had = idx.get(s);
    if (had !== undefined) return had;
    const i = syms.length;
    syms.push(s);
    idx.set(s, i);
    return i;
  };
  const body = [];
  for (const st of tb.states) {
    body.push(`i ${st.items.join(' ')}`);
    const acts = [];
    for (const [t, list] of st.actions) {
      const codes = [];
      for (const a of list) {
        codes.push(a.kind === 'shift' ? `s${a.to}` : a.kind === 'accept' ? 'a' : `r${a.rule}`);
      }
      // 空的动作表要**留住**：nonassoc 同级不结合时两边都删，那一格就是"这么写非法"
      // （见 resolveConflicts）。写成 `-`，因为 `符号号:` 后面什么都没有读回来分不清。
      acts.push(`${sym(t)}:${codes.length === 0 ? '-' : codes.join(',')}`);
    }
    body.push(`a ${acts.join(' ')}`);
    const gos = [];
    for (const [nt, to] of st.gotos) gos.push(`${sym(nt)}:${to}`);
    body.push(`g ${gos.join(' ')}`);
  }
  const conf = [`C ${tb.conflicts.length}`];
  for (const c of tb.conflicts) conf.push(`${c.state} ${sym(c.token)} ${c.kind} ${c.actions}`);
  // 符号表是边写边攒的，所以头与符号表最后拼
  const out = [`glr-table ${TABLE_FORMAT} ${tb.states.length} ${syms.length}`];
  for (const s of syms) out.push(s);
  for (const l of body) out.push(l);
  for (const l of conf) out.push(l);
  return out.join('\n') + '\n';
}

/**
 * 缓存文本 + 语法 -> 表。版本对不上（或者文本坏了）就回 null，调用方重新构表。
 * 回出来的对象与 buildTable 的**逐字段相同**（tests/glr 那条轴拿 dumpTable 逐字节比过）。
 */
export function tableFromText(text, g) {
  const lines = text.split('\n');
  const head = lines[0].split(' ');
  if (head[0] !== 'glr-table' || Number(head[1]) !== TABLE_FORMAT) return null;
  const nStates = Number(head[2]);
  const nSyms = Number(head[3]);
  if (lines.length < 1 + nSyms + nStates * 3 + 1) return null;
  const syms = [];
  for (let i = 0; i < nSyms; i++) syms.push(lines[1 + i]);
  const a = augment(g);
  const states = [];
  let p = 1 + nSyms;
  for (let i = 0; i < nStates; i++) {
    const items = [];
    const itl = lines[p].split(' ');
    for (let k = 1; k < itl.length; k++) if (itl[k] !== '') items.push(itl[k]);
    const actions = new Map();
    const al = lines[p + 1].split(' ');
    for (let k = 1; k < al.length; k++) {
      if (al[k] === '') continue;
      const parts = al[k].split(':');
      const list = [];
      if (parts[1] !== '-') {
        for (const code of parts[1].split(',')) {
          if (code === 'a') list.push({ kind: 'accept' });
          else if (code.startsWith('s')) list.push({ kind: 'shift', to: Number(code.slice(1)) });
          else list.push({ kind: 'reduce', rule: Number(code.slice(1)) });
        }
      }
      actions.set(syms[Number(parts[0])], list);
    }
    const gotos = new Map();
    const gl = lines[p + 2].split(' ');
    for (let k = 1; k < gl.length; k++) {
      if (gl[k] === '') continue;
      const parts = gl[k].split(':');
      gotos.set(syms[Number(parts[0])], Number(parts[1]));
    }
    states.push({ items, actions, gotos });
    p += 3;
  }
  const cl = lines[p].split(' ');
  if (cl[0] !== 'C') return null;
  const nc = Number(cl[1]);
  const conflicts = [];
  for (let i = 0; i < nc; i++) {
    const c = lines[p + 1 + i].split(' ');
    conflicts.push({
      state: Number(c[0]), token: syms[Number(c[1])], kind: c[2], actions: Number(c[3]),
    });
  }
  return {
    grammar: g, states, rules: a.rules, acceptRule: a.acceptRule, conflicts,
    first: a.ns.first, follow: a.follow, nullable: a.ns.nullable,
  };
}

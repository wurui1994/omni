// Omni stage0 — 语法表的构造（ADR-0014 决策 2）
//
// ## 为什么是 SLR(1) 而不是 LALR(1)
//
// bison 用 LALR(1)，因为它必须在**构表期**把冲突压到最少 —— 剩下的冲突就是错误。
// 我们不必：有了 GLR，构表期没解决的冲突留到**运行期**由分叉解决，走不通的那支自己死掉。
//
// 关键一点：SLR 与 LALR 接受的语言在 GLR 驱动下**完全相同**。两者的差别只是"错误的那支
// 什么时候死"，不是"有没有合法的分析树"。如果两支都活到最后，那这个输入对这份语法就是
// 真的有歧义 —— 用哪种表都一样。所以精度换来的只是速度，而 SLR 的构造是 LALR 的四分之一，
// 短得能一眼看完，也就一眼能审对。真嫌慢了再升级，位置就在这一个文件里。
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
    states.push({ items, actions: new Map(), gotos: new Map() });
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
      if (gg.terms.has(s)) addAction(st, s, { kind: 'shift', to });
      else st.gotos.set(s, to);
    }
  }

  // 归约与接受
  for (const st of states) {
    for (const it of st.items) {
      const ri = itemRule(it);
      const dot = itemDot(it);
      const r = rules[ri];
      if (dot !== r.rhs.length) continue;
      if (ri === acceptRule) { addAction(st, END, { kind: 'accept' }); continue; }
      for (const t of follow.get(r.lhs)) addAction(st, t, { kind: 'reduce', rule: ri });
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
    lines.push('conflicts left to the GLR driver: none (this grammar is SLR(1))');
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
export const TABLE_FORMAT = 1;

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

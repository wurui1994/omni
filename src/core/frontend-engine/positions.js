// src/core/frontend-engine/positions.js —— 位置代数：组合 + 查询 + 一致性检查（ADR-0029 的 L2）
//
// 这一份是**求解器**，里头没有任何一门语言的常量。语言给的是 `feature.positions` 那些行，
// 这儿负责：把它们并成一张表（冲突当场炸）、按 `(sort, kind)` 查、以及与**量出来的实际行为**
// 对账（`diff`）。
//
// 为什么"对账"是这套设计的关键：表若只是文档，它一定会与代码漂开。让 `tests/lib/jnc-matrix.js`
// 把每一格**真跑一遍**、再与表比，表就变成**可执行的规格**：任何漂移是一条测试失败，
// 而不是一次"撞出来的发现"（ADR-0029 第 1 节那三类账全是这么来的）。

import { VERDICTS } from './feature.js';

/** 一格的键。 */
const key = (sort, kind) => `${sort}|${kind}`;

/**
 * 把一串特性并成一张位置表。
 * @returns {{cells: Map, accounts: Map, features: string[], sorts: Set, kinds: Set}}
 */
export function compose(features) {
  const names = new Set();
  for (const f of features) {
    if (names.has(f.name)) throw new Error(`特性 '${f.name}' 装了两遍`);
    names.add(f.name);
  }
  for (const f of features) {
    for (const r of f.requires) {
      if (!names.has(r)) throw new Error(`特性 '${f.name}' 要 '${r}'，可它没装`);
    }
  }
  const accounts = new Map();
  for (const f of features) {
    for (const [id, a] of Object.entries(f.accounts)) {
      const had = accounts.get(id);
      if (had !== undefined && had.text !== a.text) {
        throw new Error(`账号 ${id} 被两个特性定成了两句话：'${had.from}' 与 '${f.name}'`);
      }
      accounts.set(id, { ...a, from: f.name });
    }
  }
  /* 两遍：先收通配（`sorts: '*'`），再收具体的 —— 具体的覆盖通配（规矩 1），
     具体的撞具体的就炸（规矩 2）。 */
  const cells = new Map();
  const wild = new Map();
  const kinds = new Set();
  const sorts = new Set();
  for (const f of features) {
    for (const r of f.positions) {
      kinds.add(r.kind);
      if (r.sorts === '*') {
        const had = wild.get(r.kind);
        if (had !== undefined && had.verdict !== r.verdict) {
          throw new Error(`'${r.kind}' 的通配结论撞了：'${had.from}' 说 ${had.verdict}、`
            + `'${r.from}' 说 ${r.verdict}`);
        }
        wild.set(r.kind, r);
      }
    }
  }
  for (const f of features) {
    for (const r of f.positions) {
      if (r.sorts === '*') continue;
      for (const s of r.sorts) {
        sorts.add(s);
        const k = key(s, r.kind);
        const had = cells.get(k);
        if (had !== undefined && (had.verdict !== r.verdict || had.account !== r.account)) {
          throw new Error(`格子 (${s}, ${r.kind}) 撞了：'${had.from}' 说 ${had.verdict}`
            + `${had.account ? `/${had.account}` : ''}、`
            + `'${r.from}' 说 ${r.verdict}${r.account ? `/${r.account}` : ''}`);
        }
        cells.set(k, r);
      }
    }
  }
  for (const id of accounts.keys()) {
    if (!/^[A-Z]-\d{3}$/.test(id)) throw new Error(`账号 '${id}' 的号不合式（要 X-000 那样）`);
    /* `match` 是拿去比**实际发出的那句话**的（见 diff），而那句话在比之前会去掉 `` ` `` 与 `*`。
       若特征里带着这两个记号，它就永远对不上 —— 那是一格"永远命中不了的规格"，
       比没规格更坏（对账会把它算成分歧，人会以为是实现漂了）。所以当场炸。 */
    const m = accounts.get(id).match;
    if (typeof m === 'string' && /[`*]/.test(m)) {
      throw new Error(`账号 ${id} 的 match 里带了 \` 或 *，那永远对不上（比的时候已经去掉了）`);
    }
  }
  /* 引用到的账号必须**有人定义**（规矩 3 的另一半）：一个账号只在一个特性里定义、别处引用它，
     于是"这句话到底什么意思、出处在哪"只有一处答案。 */
  for (const f of features) {
    for (const r of f.positions) {
      if (r.account === undefined) continue;
      if (!accounts.has(r.account)) {
        throw new Error(`特性 '${f.name}' 的 '${r.kind}' 引了账号 ${r.account}，可没人定义它`);
      }
    }
  }
  /* 被 `refuse` / `error` 那两栏引到的账号必须**能渲染成一句话**（`say`）：那一栏的诊断
     就是它渲染出来的（R5）。只当"代价"记着的账（比如 T-005：名字提到外面那层）不发话，
     也就不用 `say` —— 所以这道检查只看被那两栏引到的。 */
  for (const c of [...cells.values(), ...wild.values()]) {
    if (c.verdict !== 'refuse' && c.verdict !== 'error') continue;
    const acc = accounts.get(c.account);
    if (typeof acc.say !== 'string') {
      throw new Error(`账号 ${c.account} 被 '${c.kind}' 当结论引着，可它没有 say（发不出话）`);
    }
  }
  /* 名字类（`binding.names`）：查名时问的"要哪一类"就是它们。一个名字类只许一个特性定义 ——
     否则"这一类名字是谁带进来的、存哪儿"又变成两处答案（规矩 3 的第三半）。 */
  const nameKinds = new Map();
  for (const f of features) {
    for (const [kd, d] of Object.entries(f.binding.names ?? {})) {
      const had = nameKinds.get(kd);
      if (had !== undefined) {
        throw new Error(`名字类 '${kd}' 被两个特性定义：'${had.from}' 与 '${f.name}'`);
      }
      nameKinds.set(kd, { ...d, from: f.name });
    }
  }
  return { cells, wild, accounts, nameKinds, features: [...names], sorts, kinds };
}

/** 按 `(sort, kind)` 查一格：先看具体、再落通配；都没有回 `undefined`（= 表里没这一格）。 */
export function lookup(spec, sort, kind) {
  return spec.cells.get(key(sort, kind)) ?? spec.wild.get(kind);
}

/**
 * 把一个账号**渲染成一句诊断**（ADR-0029 的 R5：诊断由规则生成，不是手写在降级器里）。
 * 账号给一格 `say` 模板，里头的 `{名字}` 由 `vars` 填。缺一个或多一个都当场炸 ——
 * 手写字符串最爱出的错就是"话与账漂开"，模板 + 严格填空把那类错挪到了加载期。
 */
export function say(spec, id, vars = {}) {
  const acc = spec.accounts.get(id);
  if (acc === undefined) throw new Error(`账号 ${id} 没人定义`);
  if (typeof acc.say !== 'string') throw new Error(`账号 ${id} 没给 say 模板`);
  const need = new Set([...acc.say.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const k of Object.keys(vars)) {
    if (!need.has(k)) throw new Error(`账号 ${id} 的 say 里没有 {${k}} 这一格`);
  }
  return acc.say.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`账号 ${id} 的 say 缺了 {${k}}`);
    return String(vars[k]);
  });
}

/** `say` 模板里第一个 `{` 之前那截字面 —— 拿它当对账的特征，于是特征不用再手写一遍。 */
function matchOf(acc) {
  if (acc.match !== undefined) return acc.match;
  if (typeof acc.say === 'string') {
    const lit = acc.say.split('{')[0].replace(/[`*]/g, '');
    if (lit.length >= 4) return lit;
  }
  return acc.text.replace(/[`*]/g, '').slice(0, 8);
}

/** 表里还没定的格（`todo`）与压根没声明的格 —— 这两栏就是"我们不知道什么"的清单。 */
export function gaps(spec, sortList, kindList) {
  const todo = [];
  const undeclared = [];
  for (const s of sortList) {
    for (const k of kindList) {
      const c = lookup(spec, s, k);
      if (c === undefined) undeclared.push([s, k]);
      else if (c.verdict === 'todo') todo.push([s, k, c.note ?? '']);
    }
  }
  return { todo, undeclared };
}

/**
 * 与**量出来的**实际行为对账。
 * `measured` 是 `Map('sort|kind' -> {k})`，`k` 取 `ok|N|E|syn|crash`（jnc-matrix 的分类）。
 * 回一串分歧；空数组 = 表与实现一致。
 */
export function diff(spec, measured) {
  const MAP = { ok: 'ok', N: 'refuse', E: 'error', syn: 'syntax', crash: 'crash' };
  const out = [];
  for (const [k, m] of measured) {
    const [sort, kind] = k.split('|');
    const c = lookup(spec, sort, kind);
    const got = MAP[m.k] ?? m.k;
    if (c === undefined) { out.push({ sort, kind, want: '（表里没有）', got, why: m.why }); continue; }
    if (c.verdict === 'todo') continue;                 // 还没定的格不算分歧，算清单
    if (got === 'crash') { out.push({ sort, kind, want: c.verdict, got, why: m.why }); continue; }
    /* `syntax-todo` 与 `syntax` 量出来是同一种（语法不认）—— 差别在**账**：前者是我们的洞、
       后者是这门语言的规格。所以对账时把它们看成一回事。 */
    const same = c.verdict === got || (c.verdict === 'syntax-todo' && got === 'syntax');
    if (!same) { out.push({ sort, kind, want: c.verdict, got, why: m.why }); continue; }
    /* 结论对上了，还要问一句**理由对不对**（ADR-0029 的 R5）：拒绝那两类要能在实际发出的
       那句话里认出**声明的那个账号**。这一步抓的是"结论对、话说错"——第 248/251/253 刀
       那三条"认错人"就是这一类，而先前只比结论是抓不住它们的。
       账号可以给一格 `match`（子串或正则源）说明它在措辞里长什么样；不给就拿 `text` 的
       前 8 个字当特征（够区分这 25 个账号，又不至于把整句话钉死 —— 措辞还要改）。 */
    /* `ok` 那一栏也有要对的账：**名字落在哪**（`escapes`）。这一列由探针真量出来
       （jnc-matrix 那份 KINDS 的第四格：把"用一下那个名字"塞进后面一个函数体里再编一遍），
       所以"写在体里的类型名会漏到外面那层"这笔代价（T-005）从此是一条能失败的测试，
       不是文档里的一句话。 */
    if (c.escapes !== undefined && m.esc !== undefined && c.escapes !== m.esc) {
      out.push({
        sort,
        kind,
        want: `${got}/名字${c.escapes ? '漏到外面那层' : '留在原处'}`,
        got: `${got}/名字${m.esc ? '漏出去了' : '留在原处'}`,
      });
      continue;
    }
    /* 第三问：**修饰词留下痕迹了吗**（`trace`）。量法是把那几个词去掉再降一遍，两份 sx
       一模一样就说明这一层把它们丢了（jnc-matrix 的第五格）。丢了不一定是错 —— `const` /
       `unsafe` 那几个只在编译期管事 —— 所以期望写在规格里；**改了就是一条测试失败**。
       这一问是第 10.21 节那条界的补救：`ok` 只说明"没诊断"，不说明"降对了"。 */
    if (c.trace !== undefined && m.trace !== undefined && c.trace !== m.trace) {
      out.push({
        sort,
        kind,
        want: `${got}/修饰词${c.trace ? '留痕' : '不留痕'}`,
        got: `${got}/修饰词${m.trace ? '留痕了' : '没留痕'}`,
      });
      continue;
    }
    if (c.verdict !== 'refuse' && c.verdict !== 'error') continue;
    const acc = spec.accounts.get(c.account);
    if (acc === undefined) continue;
    const pat = matchOf(acc);
    const said = (m.why ?? '').replace(/[`*]/g, '');
    const hit = pat instanceof RegExp ? pat.test(said) : said.includes(pat);
    if (!hit) {
      out.push({
        sort, kind, want: `${c.verdict}/${c.account}`, got: `${got}/别的理由`, why: m.why,
      });
    }
  }
  return out;
}

export { VERDICTS };

// Omni stage0 — GLR 驱动（ADR-0014 决策 2）
//
// 抄 bison 的图结构栈（`data/skeletons/glr.c`），但**去掉了它一半的机器**，因为我们的
// 语义动作和它的不一样：
//
// - bison 的动作是任意 C 代码，有副作用，所以分叉之后动作必须**延迟**执行，还要把
//   lookahead 快照起来（glr.c:1139..1160 的 yySemanticOption / yylookaheadNeeds）。
//   我们的动作是一段纯 s-expr 模板，没有副作用，于是**当场求值**就行，那整套延迟机制不需要。
// - bison 在 `(LR 状态, 前驱)` 相同时做结构合并（glr.c:1536..1553）来把复杂度压住。
//   我们合并的条件更严一点：状态与前驱都相同、**而且值也逐节点相同**。值不同就两支都留 ——
//   那正是"这里真有两棵树"的意思，留着才能在最后说清楚是哪两棵。
// - bison 的硬边界照收：真歧义（两支都活到接受）不猜，直接报错（doc/bison.texi:1321..1325）。
//   `%merge`/`%dprec` 那套我们没有，也不打算有。
//
// 顶点是**单前驱**的：不做 DAG。代价是最坏情况下分叉数会涨，所以有一道上限，撞到就报错
// 而不是挂住。真遇到需要 DAG 的语法再说 —— 位置就在这一个文件里。

const MAX_PARSES = 400;

const isTemplateHole = (n) => n.kind === 'atom' && /^\$[0-9]+$/.test(n.value);

/** 两个 s-expr 值是否逐节点相同（不看 span） */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'atom' || a.kind === 'string') return a.value === b.value;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i++) {
    if (!sameValue(a.items[i], b.items[i])) return false;
  }
  return true;
}

/** 把若干子节点的 span 并成一个 */
function spanOf(kids) {
  // 刻意不用 Infinity 当初值：它不在封闭 ABI 的数值词汇里。第一个有 span 的子节点就是初值。
  let file = null;
  let start = 0;
  let end = 0;
  for (const k of kids) {
    const s = k === null || k === undefined ? null : k.span;
    if (!s) continue;
    if (file === null) { file = s.file; start = s.start; end = s.end; continue; }
    file = s.file;
    if (s.start < start) start = s.start;
    if (s.end > end) end = s.end;
  }
  return file === null ? null : { file, start, end };
}

/**
 * 套模板。`$k` 换成第 k 个子节点的值，其它原样复制。
 * 整个模板就是一个 `$k` 时等于"原样传上去" —— 那是最常见的一条（`(-> (E) $1)`）。
 */
function applyTemplate(tpl, kids, span) {
  if (tpl === null) return null;
  if (isTemplateHole(tpl)) {
    const i = Number(tpl.value.slice(1)) - 1;
    const got = kids[i];
    return got === undefined || got === null ? { kind: 'atom', value: '$missing', span } : got;
  }
  // 非列表的模板项（atom / string）照抄一份。刻意不写 `{...tpl}`：三种节点的字段是
  // 数得清的，手写比展开稳 —— 展开一个 dict 在原生构建里还要多走一条动态路径。
  if (tpl.kind === 'atom') return { kind: 'atom', value: tpl.value, span: tpl.span === undefined ? span : tpl.span };
  if (tpl.kind === 'string') return { kind: 'string', value: tpl.value, raw: tpl.raw, span: tpl.span === undefined ? span : tpl.span };
  return { kind: 'list', items: tpl.items.map((x) => applyTemplate(x, kids, span)), span };
}

/**
 * 分析一串词法单元，返回起始符号的值（一棵 s-expr）。失败时返回 null 并把诊断记进 diags。
 *
 * @param {any} tb buildTable 的输出
 * @param {{type: string, node: any, span: any}[]} toks 末尾不用自己加 $end
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function glrParse(tb, toks, diags) {
  const { states, rules } = tb;
  let nextId = 0;
  const mk = (state, pred, value) => ({ id: nextId++, state, pred, value });
  let tops = [mk(0, null, null)];

  for (let i = 0; i <= toks.length; i++) {
    const tk = i < toks.length ? toks[i] : { type: '$end', node: null, span: i > 0 ? toks[i - 1].span : null };

    // ---- 1) 归约到不动点。新造的顶点也要再看一遍，所以是工作表而不是一遍循环。
    const merged = new Map();
    const canShift = [];
    const accepted = [];
    const work = [...tops];
    for (const n of tops) merged.set(`${n.state}#${n.pred === null ? -1 : n.pred.id}#${n.id}`, n);
    while (work.length > 0) {
      const n = work.pop();
      const acts = states[n.state].actions.get(tk.type);
      if (acts === undefined) continue;
      for (const a of acts) {
        if (a.kind === 'shift') { canShift.push({ n, to: a.to }); continue; }
        if (a.kind === 'accept') { accepted.push(n); continue; }
        const r = rules[a.rule];
        let base = n;
        // 沿前驱链往下走，收到的是**倒序**的子节点，最后翻过来。刻意不写 `kids.unshift(...)`：
        // unshift 不在封闭 ABI 里（reverse 在），原生构建里它会变成"在 list 上取属性"。
        const rev = [];
        let broken = false;
        for (let k = 0; k < r.rhs.length; k++) {
          if (base === null) { broken = true; break; }
          rev.push(base.value);
          base = base.pred;
        }
        if (broken || base === null) continue;
        const kids = rev.reverse();
        const to = states[base.state].gotos.get(r.lhs);
        if (to === undefined) continue;
        const value = applyTemplate(r.action, kids, spanOf(kids.length > 0 ? kids : [tk]));
        // 合并：状态、前驱、值三者都一样才算同一支
        const key = `${to}#${base.id}`;
        const prev = merged.get(key);
        if (prev !== undefined && sameValue(prev.value, value)) continue;
        const nn = mk(to, base, value);
        merged.set(prev === undefined ? key : `${key}#${nn.id}`, nn);
        work.push(nn);
        if (merged.size > MAX_PARSES) {
          diags.error(tk.span, `too many concurrent parses (> ${MAX_PARSES}) — the grammar is too ambiguous around here`);
          return null;
        }
      }
    }

    // ---- 2) 接受
    if (tk.type === '$end') {
      if (accepted.length === 0) {
        diags.error(tk.span, 'unexpected end of input');
        return null;
      }
      const first = accepted[0];
      for (const other of accepted.slice(1)) {
        if (!sameValue(first.value, other.value)) {
          // bison 的硬边界：真歧义不猜（doc/bison.texi:1321..1325）
          diags.error(tk.span, 'the input is ambiguous: two different parses both succeed — the grammar needs disambiguating');
          return null;
        }
      }
      return first.value;
    }

    // ---- 3) 移进
    if (canShift.length === 0) {
      const expected = expectedAt(tb, tops);
      diags.error(tk.span, `unexpected ${describeToken(tk)}${expected === '' ? '' : `; expected ${expected}`}`);
      return null;
    }
    tops = canShift.map((s) => mk(s.to, s.n, tk.node));
  }
  return null;
}

function describeToken(tk) {
  if (tk.type === '$end') return 'end of input';
  const text = tk.node !== null && tk.node !== undefined && tk.node.kind === 'atom' ? tk.node.value : null;
  return text === null || text === tk.type ? tk.type : `${tk.type} '${text}'`;
}

/** 当前几个栈顶合起来能接什么。太多就截断 —— 诊断要能读。 */
function expectedAt(tb, tops) {
  const set = new Set();
  for (const n of tops) {
    for (const t of tb.states[n.state].actions.keys()) set.add(t);
  }
  const list = [...set].sort();
  if (list.length === 0) return '';
  if (list.length > 8) return `${list.slice(0, 8).join(', ')}, ...`;
  return list.join(', ');
}

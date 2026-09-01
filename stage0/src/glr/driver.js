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
//
// 关于 `%dprec`：**原先写的是"不打算有"，这条改了**。理由是 jancy 逼出来的 ——
// `C1* c;` 既是"声明一个 C1 指针"又是"C1 乘 c"这条语句，两棵树都合法，而**任何 LR 语法都
// 分不开它**：要分开必须知道 `C1` 是不是类型名，那是符号表的事。jancy 自己也是这么干的
// （`qualified_type_name_rslv` 里调 `findType()`，DeclarationSpecifier.llk:258..278），
// C 系语言全都绕不开。GLR 下唯一的声明式手段就是 bison 的 `%dprec`，所以照收，写成
// `(prefer N)`。要紧的是：**驱动仍然不猜** —— 没有声明过偏好的两棵树照旧报错，胜负只在
// 语法文件里明写过偏好时才判。`%merge`（把两棵树合成一棵）仍然没有，那才是真的猜。
//
// 偏好是**沿栈累加**的：顶点上记一个 pref，归约时 `新 pref = 顶点 pref + 规则的 prefer`。
// 两个顶点前驱相同就意味着栈下面那截一样，于是比 pref 就等于比"这一段派生里声明过的偏好之和"。
// 合并点上严格低的那支当场丢掉（bison 也是在合并点定胜负），接受点上再判一次 —— 后者是权威，
// 所以结果与归约次序无关，合并点的丢弃只是省掉一支反正会输的分叉。
//
// 顶点是**单前驱**的：不做 DAG。代价是最坏情况下分叉数会涨，所以有一道上限，撞到就报错
// 而不是挂住。真遇到需要 DAG 的语法再说 —— 位置就在这一个文件里。

const MAX_PARSES = 400;

const isTemplateHole = (n) => n.kind === 'atom' && /^\$[0-9]+$/.test(n.value);
const isSpliceHole = (n) => n.kind === 'atom' && /^\$\*[0-9]+$/.test(n.value);

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

/**
 * 两棵树最小的那处分歧。返回 `[a 的子树, b 的子树]`，完全相同时返回 null。
 *
 * 名字里的 Tree 不是修饰，是**必须的**：自举那一版把所有模块摊进同一个作用域，
 * 模块级的名字全局唯一才行，而 `bootstrap.js` 已经有一个按文本比的 `firstDiff` 了。
 */
function firstTreeDiff(a, b) {
  if (sameValue(a, b)) return null;
  if (a === null || b === null || a === undefined || b === undefined) return [a, b];
  if (a.kind === 'list' && b.kind === 'list' && a.items.length === b.items.length) {
    for (let i = 0; i < a.items.length; i++) {
      const d = firstTreeDiff(a.items[i], b.items[i]);
      if (d !== null) return d;
    }
  }
  return [a, b];
}

/** 一处分歧印成一行：只印形状的头，够定位就行 —— 整棵树印出来没人看得完。 */
function sketch(n) {
  if (n === null || n === undefined) return '<nothing>';
  if (n.kind === 'atom') return n.value;
  if (n.kind === 'string') return n.raw === undefined ? JSON.stringify(n.value) : n.raw;
  if (n.items.length === 0) return '()';
  const h = sketch(n.items[0]);
  return n.items.length === 1 ? `(${h})` : `(${h} ...)`;
}


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
 * 套模板。`$k` 换成第 k 个子节点的值，`$*k` 把第 k 个子节点（必须是列表）的**元素摊开**，
 * 其它原样复制。整个模板就是一个 `$k` 时等于"原样传上去" —— 那是最常见的一条
 * （`(-> (E) $1)`）。
 *
 * `$*k` 是为**列表**加的，而列表是映射标注绕不过去的东西：语句序列、实参表、形参表
 * 都是「左递归攒一串」的形状。没有它，`(-> (Stmts Stmt) ...)` 只能造出右嵌套的链，
 * 消费方（核心方言那份降级）就得反过来认那条链 —— 等于把某门语言的语法形状泄进
 * 唯一的那份降级里。有了它，语法写 `($*1 $2)` 就直接攒出一条平的列表。
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
  // span 一律换成**输入的** span：模板节点自己的 span 指向语法文件，留着它诊断就会
  // 指到语法文件里去（量出来过：一句歧义报错指在 jnc.grammar:339）。
  if (tpl.kind === 'atom') return { kind: 'atom', value: tpl.value, span };
  if (tpl.kind === 'string') return { kind: 'string', value: tpl.value, raw: tpl.raw, span };
  const items = [];
  for (const x of tpl.items) {
    if (isSpliceHole(x)) {
      const got = kids[Number(x.value.slice(2)) - 1];
      // 要摊开的东西不是列表时不静默：那是语法写错了，在这里报比在降级里报清楚得多
      if (got === undefined || got === null || got.kind !== 'list') {
        items.push({ kind: 'atom', value: '$notalist', span });
        continue;
      }
      for (const y of got.items) items.push(y);
      continue;
    }
    items.push(applyTemplate(x, kids, span));
  }
  return { kind: 'list', items: items, span };
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
  const mk = (state, pred, value, pref) => ({ id: nextId++, state, pred, value, pref });
  let tops = [mk(0, null, null, 0)];

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
        // 沿前驱链往下走，收到的是**倒序**的子节点，最后翻过来。这里不写
        // `kids.unshift(...)`：翻一次是线性的，逐格 unshift 是二次的
        //（第一百〇四刀给 ABI 补了 unshift，所以现在只是效率的取舍，不是缺口）。
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
        const pref = n.pref + r.prefer;
        // 合并：状态、前驱、值三者都一样才算同一支。值不同就看偏好 —— 严格低的那支现在就丢，
        // 反正它在接受点也要输（见文件头）。没声明过偏好时两边都是 0，谁也不丢，照旧两支都留。
        const key = `${to}#${base.id}`;
        const prev = merged.get(key);
        if (prev !== undefined && sameValue(prev.value, value)) continue;
        if (prev !== undefined && pref < prev.pref) continue;
        const nn = mk(to, base, value, pref);
        merged.set(prev === undefined ? key : `${key}#${nn.id}`, nn);
        work.push(nn);
        if (merged.size > MAX_PARSES) {
          diags.error(tk.span, `too many concurrent parses (> ${MAX_PARSES}) — the grammar is too ambiguous around here`);
          return null;
        }
      }
    }

    // ---- 1.5) 按偏好剪支。归约全做完了才能剪，所以这一步在不动点之后：
    // 同一个 `(状态, 前驱)` 上只留偏好最高的那些。归约期只能丢"后来的、偏好更低的那支"
    // （先到的那支可能已经往下长了），单靠那一手不够 —— `T* x;`（声明还是乘法）每写一行就
    // 让分叉翻一倍，七行连着写就撞 MAX_PARSES。量出来的：jnc_sample_03_dialog/script.jnc。
    //
    // 归约把输掉的那棵子树**装进了**新顶点的值里，而胜负双方的新顶点 `(状态, 前驱)` 相同，
    // 所以在这一层剪就正好剪掉它。前驱被剪掉的顶点跟着剪：它带的也是输掉的那条派生。
    let live = canShift;
    let liveAccepted = accepted;
    const nodes = [...merged.values()];
    const groupOf = (n) => `${n.state}#${n.pred === null ? -1 : n.pred.id}`;
    const bestOf = new Map();
    for (const n of nodes) {
      const b = bestOf.get(groupOf(n));
      if (b === undefined || n.pref > b) bestOf.set(groupOf(n), n.pref);
    }
    const cut = new Set();
    for (const n of nodes) {
      if (n.pref < bestOf.get(groupOf(n))) cut.add(n.id);
    }
    if (cut.size > 0) {
      let again = true;
      while (again) {
        again = false;
        for (const n of nodes) {
          if (!cut.has(n.id) && n.pred !== null && cut.has(n.pred.id)) { cut.add(n.id); again = true; }
        }
      }
      live = canShift.filter((s) => !cut.has(s.n.id));
      liveAccepted = accepted.filter((n) => !cut.has(n.id));
    }

    // ---- 2) 接受
    if (tk.type === '$end') {
      if (liveAccepted.length === 0) {
        diags.error(tk.span, 'unexpected end of input');
        return null;
      }
      // 偏好最高的那些支才有资格。它们之间还不一致，就是真歧义 —— 报错，不猜。
      let best = liveAccepted[0];
      for (const other of liveAccepted) {
        if (other.pref > best.pref) best = other;
      }
      for (const other of liveAccepted) {
        if (other.pref < best.pref) continue;
        if (!sameValue(best.value, other.value)) {
          // bison 的硬边界：真歧义不猜（doc/bison.texi:1321..1325）。
          // 报错时把**最小的那处分歧**指出来 —— 只说"两棵树"没法改语法，得知道分在哪。
          const d = firstTreeDiff(best.value, other.value);
          const at = d === null ? null : d[0] !== null && d[0] !== undefined && d[0].span ? d[0].span : tk.span;
          const what = d === null ? '' : `: one parse says ${sketch(d[0])}, the other ${sketch(d[1])}`;
          diags.error(at, `the input is ambiguous — two different parses both succeed${what}`);
          return null;
        }
      }
      return best.value;
    }

    // ---- 3) 移进
    if (live.length === 0) {
      const expected = expectedAt(tb, tops);
      diags.error(tk.span, `unexpected ${describeToken(tk)}${expected === '' ? '' : `; expected ${expected}`}`);
      return null;
    }
    tops = live.map((s) => mk(s.to, s.n, tk.node, s.n.pref));
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

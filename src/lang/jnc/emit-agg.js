// src/lang/jnc/emit-agg.js —— 一格聚合体发成方言的 `(struct …)`：**三条规则**
//
// 已经搬进这一份的规则（全是尺子从旧降级真输出里逼出来的，`tests/lib/jnc-struct-emit.js`）：
//   1. **类多头一格 `$tag int`**（第五十二/五十六刀）；
//   2. **基类的字段在前**（`struct Point3D: Point2D {…}` → `(m_x)(m_y)(m_z)`，递归摊平）；
//   3. 自己的字段按**源码次序**，收 data / array / fnptr 三族；
//   4. **匿名 union** 摊平再括回 `(union …)`（第一百一十刀）；
//   5. **位域**按底宽挤成 `$bN`（104-bitfield.jnc：4+4 进一格 uint8、5+5 挤不进、24+8 进一格 uint32）；
//   6. union 里套**匿名 struct** 各自发一行，名字 `<东家>$u<union 的成员序号>$s<第几个匿名 struct>`
//      （103-unionstruct.jnc；`$s` 数的是匿名 struct 的个数 —— 104 的 `Ctl` 把这一格钉死）。
//
// **类那一族的大规则（刚从尺子上看清，还没实现）**：旧降级**一整条继承链只发一格结构体**
// （第五十六刀的 `clsRoot`）—— 派生类不另发，它们的字段**并进根那一格**，按声明次序排在后面。
// 128-basetypedef.jnc 是最干净的一例：`class B0 {}` 加四个派生类，旧降级发的是
//   `(struct B0 ($tag int) (m_v int) (m_p B0$Pair) (m_mid int) (m_c int))`
// —— 那四格分别长在 D0/D1/D2/D3 上。129-baseparam.jnc 同理。这也解释了尺子那一栏
// "旧降级没发这个聚合体：34 个" —— 那 34 个就是派生类。
// 所以"一格聚合体发一行"对 struct 成立、对 class **不成立**：下一刀要按**链的根**分组，
// 根那一行把整条链的字段并起来（现在的 `baseFields` 是反着做的 —— 从派生类往上抄基类字段，
// 那是 struct 的规矩）。
//
// 另外三族（尺子每次都印，出处在括号里）：
//   - 属性的**隐藏存储字段** `<东家>$<属性名>$<字段名>`（141-propfullmem / 150-variantautoget /
//     151-propfield / 152-propfieldinit）；
//   - **事件字段**发 `(arr (fnty () void))`（142-propalias 的 `m_onAny`，多播那一格）；
//   - **带名字的 union** 也进字段表（166-unionnamed）。

import { resolveType, baseIntBits, bitfieldBits } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { nameText, allInChain } from './declare.js';
import { headOf } from './adapt.js';

/** 类那一族头上那一格。 */
export const CLASS_TAG = '($tag int)';

/**
 * 拼一行 `(struct 名字 …)`。`env` 是 `名字 -> { kind, name, agg }`。
 * 有一格字段解不出来、或者碰上还没搬的那几族，答 `{ line: null, why }`。
 * `lines` 里还带上**顺带发出来的那几行**（union 里套的匿名 struct 各自一行，先发）。
 */
export function structLine(agg, env) {
  const name = agg.emitName ?? nameText(agg.name);
  if (name === null) return { line: null, lines: [], why: '无名聚合体' };
  const parts = [];
  if (agg.word === 'class' || agg.word === 'opaque class') parts.push(CLASS_TAG);
  const bases = baseFields(agg, env);
  if (bases === null) return { line: null, lines: [], why: '基类那一格还解不出来' };
  parts.push(...bases);
  const extra = [];
  const own = ownFields(agg, env, { owner: name, extra });
  if (own === null) return { line: null, lines: [], why: '有字段还解不出来' };
  parts.push(...own);
  if (parts.length === 0) return { line: null, lines: [], why: '一格字段都没有' };
  const line = `(struct ${name} ${parts.join(' ')})`;
  return { line, lines: [...extra, line], why: null };
}

/** 基类（可能是一串、可能套几层）的字段，按继承次序摊平。 */
function baseFields(agg, env) {
  const out = [];
  for (const b of basePaths(agg)) {
    const rec = env.get(b);
    if (rec === undefined || rec.agg === undefined) return null;    // 跨文件的基类：还解不出来
    const up = baseFields(rec.agg, env);
    if (up === null) return null;
    out.push(...up);
    const own = ownFields(rec.agg, env);
    if (own === null) return null;
    out.push(...own);
  }
  return out;
}

/** 基类表里每一格的**最后一段名字**（`io.Base` 取 `Base`；空基类表答空）。 */
function basePaths(agg) {
  const bases = agg.bases;
  if (bases === null || bases === undefined) return [];
  if (headOf(bases) === 'bases') return [];                         // `(bases)`：没有基类
  const out = [];
  for (const q of allInChain(bases, 'qnames-add', 'qnames')) {
    const n = lastIdent(q);
    if (n !== null) out.push(n);
  }
  return out;
}

/** 一格限定名的最后一段标识符（原树上按位置找 —— 这一层不借规整器）。 */
function lastIdent(n) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return typeof n.value === 'string' ? n.value : null;
  for (let i = n.items.length - 1; i >= 1; i -= 1) {
    const s = lastIdent(n.items[i]);
    if (s !== null) return s;
  }
  return null;
}

/** 自己那几格数据字段。`ctx` 带着东家的名字与"顺带要发的那几行"。 */
function ownFields(agg, env, ctx = { owner: '', extra: [] }) {
  const out = [];
  /* 位域挤格子的状态：`bits` 是底宽、`used` 是已经占掉的位数。碰上非位域就**收口**。 */
  let pack = null;
  const flush = () => {
    if (pack !== null) { out.push(`($b${out.length} int)`); pack = null; }
  };
  agg.members.forEach((m, i) => {
    /* **匿名 union**：成员摊进外面这个结构体，发的时候括回成 `(union …)`（第一百一十刀）。
       带名字的嵌套类型不摊 —— 它是另一格类型，字段表里没有它。 */
    if (m.shape === 'nested-type') {
      const n = m.nested;
      if (n === null || n === undefined || n.word !== 'union') return;
      if (nameText(n.name) !== null) return;                        // 有名字的 union 不摊
      flush();
      const inner = unionFields(n, env, ctx, i);
      if (inner === null) { out.push(null); return; }               // 里头有解不出来的：整格作废
      if (inner.length > 0) out.push(`(union ${inner.join(' ')})`);
      return;
    }
    if (m.shape === 'bitfield') {
      /* **连着的位域挤成一格**：同一个底宽、累计位数不超过那个宽就接着挤，否则另起一格。
         格名是 `$b<这一格的序号>`（规则从旧降级的真输出反出来，104-bitfield.jnc）。 */
      const bits = baseIntBits(m.type);
      const n = bitfieldBits(m.type);
      if (bits === null || n === null) { out.push(null); return; }  // 认不出底宽/位数：不猜
      if (pack !== null && (pack.bits !== bits || pack.used + n > bits)) flush();
      if (pack === null) pack = { bits, used: 0 };
      pack.used += n;
      return;
    }
    /* 函数指针字段也是一格数据（`(m_op (fnty (int int) int))`，109-fnfield.jnc）。 */
    if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') return;
    if (m.name === null) { out.push(null); return; }
    flush();
    const r = resolveType(m.type, env);
    if (r.type === null) { out.push(null); return; }
    out.push(`(${m.name} ${emitType(r.type, 'field')})`);
  });
  flush();
  return out.some((x) => x === null) ? null : out;
}

/**
 * 匿名 union 里那几格。里头再套**匿名 struct** 时按旧降级的命名各自发一行：
 * `<东家>$u<union 的成员序号>$s<struct 在 union 里的序号>`，字段名是 `$s<同一个序号>`
 * （出处：103-unionstruct.jnc 的真输出 `(union ($s0 H$u1$s0) ($s1 H$u1$s1))`）。
 */
function unionFields(uni, env, ctx, unionAt) {
  const out = [];
  let bad = false;
  /* `$s` 那个序号数的是**匿名 struct 的个数**，不是成员的位置 —— `Ctl` 里 union 的第 0 格是
     `m_value`、第 1 格才是匿名 struct，而旧降级发的是 `$s0`（104-bitfield.jnc）。
     `H` 那处两格都是匿名 struct，两种数法看不出差别，是 `Ctl` 这一格把它钉死的。 */
  let sn = 0;
  uni.members.forEach((m) => {
    if (m.shape === 'nested-type') {
      const inner = m.nested;
      if (inner === null || inner === undefined) return;
      if (inner.word === 'struct' && nameText(inner.name) === null) {
        const j = sn;
        sn += 1;
        const nm = `${ctx.owner}$u${unionAt}$s${j}`;
        const fields = ownFields(inner, env, { owner: nm, extra: ctx.extra });
        if (fields === null) { bad = true; return; }
        ctx.extra.push(`(struct ${nm} ${fields.join(' ')})`);
        out.push(`($s${j} ${nm})`);
        return;
      }
      return;                                                       // 别的嵌套类型不摊
    }
    if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') return;
    if (m.name === null) { bad = true; return; }
    const r = resolveType(m.type, env);
    if (r.type === null) { bad = true; return; }
    out.push(`(${m.name} ${emitType(r.type, 'field')})`);
  });
  return bad ? null : out;
}

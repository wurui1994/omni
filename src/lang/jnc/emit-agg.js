// src/lang/jnc/emit-agg.js —— 一格聚合体发成方言的 `(struct …)`：**三条规则**
//
// 规则不是我想的，是尺子从旧降级的真输出里逼出来的（`tests/lib/jnc-struct-emit.js` 整行那一栏）：
//   1. **类多头一格 `$tag int`** —— 类那一族在方言里带一格标签（继承链共用一格结构体，
//      第五十二/五十六刀）。`(struct Node ($tag int) (m_v int) …)`。
//   2. **基类的字段在前** —— `struct Point3D: Point2D { int m_z; }` 发的是
//      `(struct Point3D (m_x int) (m_y int) (m_z int))`：基类那几格先躺着。
//   3. 自己的字段按**源码次序**，只收数据那两族（data / array）。
//
// 还没搬的（记账，`structLine` 答 null 或者少几格）：
//   - **位域**摊成 `$bN`。规则已经从旧降级的真输出反出来了（104-bitfield.jnc）：
//     连着的位域按"同一个底宽 + 累计位数不超过那个宽"合成一格，格名是 `$b<这一格的序号>`。
//     源码 `m_a:4 m_b:4 / int m_x / m_c:5 m_d:5 m_e:5(uint16) m_s:4(char) m_off:24 m_cnt:8(uint32)`
//     发的是 `($b0 int) (m_x int) ($b2 int) ($b3 int) ($b4 int) ($b5 int) ($b6 int)` ——
//     4+4 挤进一格 uint8，5+5 挤不进（10 > 8）所以各一格，24+8 正好挤进一格 uint32。
//     缺的那一格是**底宽表**（uint8_t→8、uint16_t→16、uint32_t→32、char→8…），
//     `resolveType` 现在把整数一律解成 `int`，宽度信息没留 —— 那是下一刀。
//   - union 里套**匿名 struct** 的命名（`H$u1$s0`，103-unionstruct.jnc）。
//   - 属性 / 事件那几族带出来的隐藏字段。

import { resolveType, baseIntBits, bitfieldBits } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { nameText, allInChain } from './declare.js';
import { headOf } from './adapt.js';

/** 类那一族头上那一格。 */
export const CLASS_TAG = '($tag int)';

/**
 * 拼一行 `(struct 名字 …)`。`env` 是 `名字 -> { kind, name, agg }`。
 * 有一格字段解不出来、或者碰上还没搬的那几族，答 `{ line: null, why }`。
 */
export function structLine(agg, env) {
  const name = agg.emitName ?? nameText(agg.name);
  if (name === null) return { line: null, why: '无名聚合体' };
  const parts = [];
  if (agg.word === 'class' || agg.word === 'opaque class') parts.push(CLASS_TAG);
  const bases = baseFields(agg, env);
  if (bases === null) return { line: null, why: '基类那一格还解不出来' };
  parts.push(...bases);
  const own = ownFields(agg, env);
  if (own === null) return { line: null, why: '有字段还解不出来' };
  parts.push(...own);
  if (parts.length === 0) return { line: null, why: '一格字段都没有' };
  return { line: `(struct ${name} ${parts.join(' ')})`, why: null };
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

/** 自己那几格数据字段。 */
function ownFields(agg, env) {
  const out = [];
  /* 位域挤格子的状态：`bits` 是底宽、`used` 是已经占掉的位数。碰上非位域就**收口**。 */
  let pack = null;
  const flush = () => {
    if (pack !== null) { out.push(`($b${out.length} int)`); pack = null; }
  };
  for (const m of agg.members) {
    /* **匿名 union**：成员摊进外面这个结构体，发的时候括回成 `(union …)`（第一百一十刀）。
       带名字的嵌套类型不摊 —— 它是另一格类型，字段表里没有它。 */
    if (m.shape === 'nested-type') {
      const n = m.nested;
      if (n === null || n === undefined || n.word !== 'union') continue;
      if (nameText(n.name) !== null) continue;                      // 有名字的 union 不摊
      flush();
      const inner = ownFields(n, env);
      if (inner === null) return null;
      if (inner.length > 0) out.push(`(union ${inner.join(' ')})`);
      continue;
    }
    if (m.shape === 'bitfield') {
      /* **连着的位域挤成一格**：同一个底宽、累计位数不超过那个宽就接着挤，否则另起一格。
         格名是 `$b<这一格的序号>`（规则从旧降级的真输出反出来，104-bitfield.jnc）。 */
      const bits = baseIntBits(m.type);
      const n = bitfieldBits(m.type);
      if (bits === null || n === null) return null;                 // 认不出底宽/位数：不猜
      if (pack !== null && (pack.bits !== bits || pack.used + n > bits)) flush();
      if (pack === null) pack = { bits, used: 0 };
      pack.used += n;
      continue;
    }
    if (m.shape !== 'data' && m.shape !== 'array') continue;
    if (m.name === null) return null;
    flush();
    const r = resolveType(m.type, env);
    if (r.type === null) return null;
    out.push(`(${m.name} ${emitType(r.type, 'field')})`);
  }
  flush();
  return out;
}

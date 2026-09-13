// src/lang/jnc/elements.js —— **要素表是生成出来的**（不再手写一份）
//
// 输入是 `syntax.js` 那张词汇表（照 jancy 的 .llk 抄的），输出是"一格能编的声明"的清单。
// 每一格带着它由哪几个词拼成（`words`）—— 于是"这门语言有多少种要素"不是我数出来的，
// 是**乘出来的**：
//
//   修饰符 × 声明符形状（按 `on` / `kind` 配对）
//   存储说明符 × 声明符形状
//   带体的命名类型
//   特殊成员（construct / destruct / 算符那一族）
//   三种上下文都收的那四族 + 各上下文独有的那几族
//
// 这一份**只生成源码**，不说"这一格该不该收" —— 结论那一半是位置表（features/*.js）的事，
// 而两边的键都是这儿给的 `name`，所以对不上就是一条测试失败（ADR-0029 的 R1/R3）。

import {
  STORAGE, TYPES, MODS, DECLARATORS, NAMED_TYPES, SPECIALS, COMMON, CONTEXT_ONLY,
} from './syntax.js';

/** 一格要素：`{name, src, group, words, dcl}`。`src` 是那一句源码（不带缩进）。 */
function el(name, src, group, words, dcl = null) {
  return { name, src, group, words, dcl };
}

/* 拿哪一种类型去写那一格：数据用 int（最少噪音），函数回 int，属性也用 int。
   `void` / `class` / `anydata` 那几种是另外单列的（它们本身就是一格要素）。 */
const T = 'int';

/** 修饰符与声明符配不配（`MODS[m].on` vs `DECLARATORS[d].kind`）。 */
const fits = (m, d) => {
  const on = MODS[m].on;
  const kind = DECLARATORS[d].kind;
  if (on === 'any') return true;
  if (on === 'data') return kind === 'data';
  if (on === 'fn') return kind === 'fn' || kind === 'data';   // 函数指针那一格也算数据形状
  if (on === 'prop') return kind === 'prop';
  return false;
};

/** 生成全部要素。 */
export function elements() {
  const out = [];

  // 1. 光声明符（基线）：没有任何修饰词的那几种形状
  for (const [d, spec] of Object.entries(DECLARATORS)) {
    out.push(el(`dcl:${d}`, spec.render('m_x', T), 'declarator', [], d));
  }

  // 2. 修饰符 × 声明符
  for (const m of Object.keys(MODS)) {
    for (const [d, spec] of Object.entries(DECLARATORS)) {
      if (!fits(m, d)) continue;
      const src = `${MODS[m].text} ${spec.render(`m_${m}_${d.replace(/-/g, '')}`, T)}`;
      out.push(el(`mod:${m}×${d}`, src, 'modifier', [m], d));
    }
  }

  // 3. 存储说明符 × 声明符（typedef / alias 那两个另有形状，单列）
  for (const s of Object.keys(STORAGE)) {
    if (s === 'typedef' || s === 'alias') continue;
    for (const [d, spec] of Object.entries(DECLARATORS)) {
      if (d === 'prop-full' || d === 'fn-body') {
        // 带体的那两种与存储词一起写才有意思（static 方法 / virtual 方法…）
        out.push(el(`sto:${s}×${d}`, `${STORAGE[s].text} ${spec.render(`m_${s}`, T)}`, 'storage', [s], d));
        continue;
      }
      if (d !== 'plain' && d !== 'fn-proto') continue;         // 别的形状与存储词的组合噪音大
      out.push(el(`sto:${s}×${d}`, `${STORAGE[s].text} ${spec.render(`m_${s}_${d.replace(/-/g, '')}`, T)}`, 'storage', [s], d));
    }
  }

  // 4. typedef / alias 那两族（形状不一样：目标在右边）
  out.push(el('sto:typedef×type', 'typedef int TdNum;', 'storage', ['typedef']));
  out.push(el('sto:typedef×fn', 'typedef int TdFn(int);', 'storage', ['typedef']));
  out.push(el('sto:typedef×fnptr', 'typedef function TdVoidFn(int);', 'storage', ['typedef']));
  out.push(el('sto:alias×fn', 'alias alFn = probeFn;', 'storage', ['alias']));
  out.push(el('sto:alias×self', 'alias alSelf = probeSelf;', 'storage', ['alias']));

  // 5. 带体的命名类型
  for (const [k, spec] of Object.entries(NAMED_TYPES)) {
    out.push(el(`type:${k}`, spec.render(`Gen${k.replace(/-/g, '')}`), 'named-type', [k]));
  }

  // 6. 特殊成员
  for (const [k, spec] of Object.entries(SPECIALS)) {
    out.push(el(`spec:${k}`, spec.render(), 'special', [k]));
  }

  // 7. 三种上下文都收的那四族（Decl.llk:25-30）
  out.push(el('common:using', 'using namespace probeNs;', 'common', ['using']));
  out.push(el('common:pragma', 'pragma(ExposedEnums, true);', 'common', ['pragma']));
  out.push(el('common:attribute-block', '[genAttr = 1] int m_ga;', 'common', ['attribute-block']));
  // named-type 那一族已经在第 5 步里
  void COMMON;

  // 8. 各上下文独有的那几族（Decl.llk:39-113）—— 写在别处正是要量的那一格
  out.push(el('only:namespace', 'namespace genNs {\n\tint genNsFn() {\n\t\treturn 0;\n\t}\n}', 'context-only', ['namespace']));
  out.push(el('only:extension', 'extension GenExt: Helper {\n\tint extra() {\n\t\treturn 3;\n\t}\n}', 'context-only', ['extension']));
  out.push(el('only:friend', 'friend Helper;', 'context-only', ['friend']));
  out.push(el('only:access-label', 'public:', 'context-only', ['access-label']));
  out.push(el('only:statement', 'genSum += 1;', 'context-only', ['statement']));
  out.push(el('only:catch-label', 'catch:', 'context-only', ['catch-label']));
  out.push(el('only:finally-label', 'finally:', 'context-only', ['finally-label']));
  out.push(el('only:nested-scope-label', 'nestedscope:', 'context-only', ['nested-scope-label']));
  void CONTEXT_ONLY;

  // 9. 别的类型说明符本身（void / class / anydata 那几种）
  for (const k of ['void', 'class', 'anydata', 'bool', 'char', 'short', 'long', 'float', 'double',
    'intptr', 'property-template']) {
    const t = TYPES[k];
    const nm = `m_t${k.replace(/-/g, '')}`;
    out.push(el(`ty:${k}`, k === 'void' ? `void ${nm}();` : `${t.sample} ${nm};`, 'type-spec', [k]));
  }

  return out;
}

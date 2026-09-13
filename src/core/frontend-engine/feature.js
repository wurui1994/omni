// src/core/frontend-engine/feature.js —— 特性（feature）与组合（ADR-0029 的 L2 起）
//
// **一门语言 = 一串特性的组合**，不是一个 15,000 行的类。一个特性是一束**贡献**：
//
//   positions   位置 × 要素 矩阵里的若干格（这一格允许吗、谁登记名字、落到哪个容器）
//   accounts    这个特性自己的账（拒绝的理由 → 出处 + "要落它得先有什么"）
//   binding     这个特性带进来的**名字类**（`binding.names`）：查名时问的"要哪一类"
//               就是它们（见 positions.js 的 compose 与 jnc 的 NAME_KINDS）
//   types       类型词汇与转换偏序表里的若干行（Phase 2 之后）
//   lower       小步重写（P01…P10 里的若干步，Phase 4）
//
// 这一份只做**最外面那层骨架 + 组合的规则**，因为组合的规则才是"可复用"的关键：
// 两个特性对同一格给出不同结论时必须**当场炸**（而不是靠加载顺序悄悄覆盖），
// 这样"jnc 与 C++ 共用哪几个特性、各自改哪几格"才有可判定的答案。
//
// 组合的三条规矩（借 MPS 的 language module 与 Racket 的 language-as-library，去掉编辑器那一摊）：
//
//   1. **显式优于通配**：`sorts: '*'` 是通配，列出来的具体 sort 覆盖它 —— 同一格上
//      "通配 vs 具体"不算冲突，"具体 vs 具体"算。
//   2. **冲突即错**：两个特性给同一格同样具体的结论且不一致 → 抛错，两边的名字都印出来。
//   3. **依赖显式**：特性可以 `requires` 另一个特性（`property-full` 要 `properties`），
//      缺了就抛错 —— 于是"这门语言由哪些特性拼成"是一张能读的清单，不是隐式的调用图。

/** 一格结论的四种取值。`todo` 是**合法**的：它说"这一格还没定"，会被一致性检查列成清单。 */
export const VERDICTS = new Set(['ok', 'refuse', 'error', 'syntax', 'todo']);

/**
 * 一条位置声明：
 *   { kind, sorts, verdict, account?, registrar?, container?, note? }
 * `sorts` 是 `'*'` 或者一串 sort 名字。
 */
function normRows(name, rows) {
  const out = [];
  for (const r of rows) {
    if (typeof r.kind !== 'string') throw new Error(`特性 ${name}：位置声明缺 kind`);
    if (!VERDICTS.has(r.verdict)) {
      throw new Error(`特性 ${name}：'${r.kind}' 的结论 '${r.verdict}' 不是那五种之一`);
    }
    if ((r.verdict === 'refuse' || r.verdict === 'error') && r.account === undefined) {
      throw new Error(`特性 ${name}：'${r.kind}' 拒了却没给账号（account）`);
    }
    const sorts = r.sorts === '*' ? '*' : [...r.sorts];
    out.push({ ...r, sorts, from: name });
  }
  return out;
}

/** 立一个特性。只做形状检查 —— 语义检查在 compose 里（那儿才看得见别的特性）。 */
export function feature({
  name, doc = '', requires = [], positions = [], accounts = {},
  binding = {}, types = {}, lower = [],
}) {
  if (typeof name !== 'string' || name === '') throw new Error('特性要一个名字');
  return {
    name,
    doc,
    requires: [...requires],
    positions: normRows(name, positions),
    accounts: { ...accounts },
    binding: { ...binding },
    types: { ...types },
    lower: [...lower],
  };
}

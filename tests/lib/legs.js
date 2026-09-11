// Omni — 「这一趟跑哪几条腿」的开关只有一处（ADR-0023）
//
// 好几条轴都是"同一份源码喂给 N 个执行器、输出必须逐字节相同"。那 N 条腿里每一条都是
// **等价的一份钱**：量出来（tests/jnc 冷跑 578 次子进程 38.9s）按腿分的真跑耗时是
// interp 35.1s、run 34.7s、run-c 30.1s、run-llvm 27.3s、run-jit 24.8s —— 纯 JS 的那几条
// 跟 C/LLVM 那几条一样贵，所以贵的不是外面的工具链，是**我们自己每个进程里那一遍编译**。
// 于是省钱只有一条路：平时少跑几条腿，跑齐的那一遍留给提交前（`OMNI_LEGS=all`）。
//
// **但留哪几条是一门语言一门语言定的，不是一张全局名单。** 每条轴自己最要紧的那条腿，
// 取决于这门语言在真实世界里**怎么跑**：
//   - jancy（tests/jnc）：`run-jit`。jancy 自己没有 AOT，`jnc` 就是 ORC JIT 跑的
//     （ADR-0022 的 J1）—— 那是这门语言的原生执行路径，别的腿都是我们自己多出来的。
//   - glsl / gpu：也是 LLVM 那一侧（那两条轴的形状不是"N 条腿比字节"，是
//     `emit-spirv` 加一条 CPU 参照，所以没有这张表可挑）。
//   - asymptote（tests/asy）：`run-llvm` —— 那边判分的人是真 asy，腿只是我们这一侧的实现。
//   - 核心方言（tests/sexpr）：`run` 是最快的基准。
// 所以下面**没有**默认名单：`pickLegs` 的 `keep` 是必填的，每条轴在自己那儿写清理由。
// 一张全局名单必然把"每门语言最要紧的那条"抹平成同一条，那正是要防的事。
//
// 中间那几条（run-c / interp / interp --mir）盯的是"腿与腿分叉"—— 那一格由提交前
// 那一遍 `OMNI_LEGS=all` 管，不在每次迭代里花。

/** 提交前那一遍：`OMNI_LEGS=all`。别的都按各条轴自己留的那几条走。 */
export const FULL_LEGS = process.env.OMNI_LEGS === 'all';

/**
 * 从一张完整的腿表里挑出这一趟要跑的那几条。
 *
 * @param {Array<{tag: string}>} all 完整的腿表
 * @param {string[]} keep 这条轴平时留下的那几条（**必填** —— 见文件头那段）。
 *   按这里给的顺序返回：第一条是基准，别的都拿去跟它比。
 */
export function pickLegs(all, keep) {
  if (FULL_LEGS) return [...all];
  if (!Array.isArray(keep) || keep.length === 0) {
    throw new Error('pickLegs: keep 是必填的 —— 每条轴要自己说清留哪几条腿');
  }
  const picked = keep.map((t) => all.find((l) => l.tag === t)).filter((l) => l !== undefined);
  // 一条都没挑着说明 tag 写错了 —— 静默跑零条腿等于这条轴整个没在量，比红更坏。
  if (picked.length === 0) {
    throw new Error(`pickLegs: 腿表里没有 ${keep.join(' / ')}（有的是 ${all.map((l) => l.tag).join(' / ')}）`);
  }
  return picked;
}

/** 报告末尾那句提示。跑齐了就不用提。 */
export function legNote(legs) {
  return FULL_LEGS ? '' : `腿：${legs.map((l) => l.tag).join(' == ')}（OMNI_LEGS=all 跑齐全部）`;
}

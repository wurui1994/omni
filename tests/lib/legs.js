import { spawnSync } from 'node:child_process';
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
/**
 * 这台机器上有 LLVM 吗（`llvm-config`，`OMNI_LLVM_CONFIG` 可以指别的）。
 *
 * 为什么要这一格：`run-llvm` / `run-jit` 那几条腿要它才跑得起来，**没有它时那不是红，
 * 是这条腿跑不了**。量到过后果：这台机器上没装 llvm-config，于是 tests/sexpr 报
 * 82 passed / 16 failed —— 16 个红全是"llvm 那条腿起不来"，而且被子进程暖存盖了很久
 * （删掉暖存才露出来）。**假红比没测更坏**：它让判据不可用，于是没人再看它。
 * README 那句"没有的套件会自己跳过"说的就是这一条，只是这儿一直没接上。
 */
let llvmMemo = null;
export function llvmAvailable() {
  if (llvmMemo !== null) return llvmMemo;
  const cfg = process.env.OMNI_LLVM_CONFIG === undefined || process.env.OMNI_LLVM_CONFIG === ''
    ? 'llvm-config' : process.env.OMNI_LLVM_CONFIG;
  let ok = false;
  try {
    ok = spawnSync(cfg, ['--version'], { stdio: 'ignore', timeout: 20000 }).status === 0;
  } catch { ok = false; }
  llvmMemo = ok;
  return ok;
}

/** 这一趟被跳掉的腿（报告末尾要说一句 —— 静默跳过与假红一样坏）。 */
export const SKIPPED_LEGS = [];

/** 需要 LLVM 的那几条腿（tag 里带 llvm 或 jit）。 */
const needsLlvm = (tag) => tag.includes('llvm') || tag.includes('jit');

export function pickLegs(all, keep) {
  const drop = (legs) => {
    if (llvmAvailable()) return legs;
    const out = [];
    for (const l of legs) {
      if (needsLlvm(l.tag)) {
        if (!SKIPPED_LEGS.includes(l.tag)) SKIPPED_LEGS.push(l.tag);
        continue;
      }
      out.push(l);
    }
    /* 一条都不剩就别跳了 —— 那等于这条轴整个没在量，比假红更坏（与下面那句同一条规矩）。 */
    return out.length === 0 ? legs : out;
  };
  if (FULL_LEGS) return drop([...all]);
  if (!Array.isArray(keep) || keep.length === 0) {
    throw new Error('pickLegs: keep 是必填的 —— 每条轴要自己说清留哪几条腿');
  }
  const picked = keep.map((t) => all.find((l) => l.tag === t)).filter((l) => l !== undefined);
  // 一条都没挑着说明 tag 写错了 —— 静默跑零条腿等于这条轴整个没在量，比红更坏。
  if (picked.length === 0) {
    throw new Error(`pickLegs: 腿表里没有 ${keep.join(' / ')}（有的是 ${all.map((l) => l.tag).join(' / ')}）`);
  }
  return drop(picked);
}

/** 报告末尾那句提示。跑齐了就不用提。 */
export function legNote(legs) {
  const skip = SKIPPED_LEGS.length === 0 ? ''
    : `  跳过：${SKIPPED_LEGS.join(' / ')}（这台机器上没有 llvm-config；OMNI_LLVM_CONFIG 可以指一份）`;
  if (FULL_LEGS) return skip === '' ? '' : skip.trim();
  return `腿：${legs.map((l) => l.tag).join(' == ')}（OMNI_LEGS=all 跑齐全部）${skip}`;
}

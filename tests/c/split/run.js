// tests/c/split/run.js —— `omni c split` 的判据（ADR-0046 §4）
//
// 硬线只有一条：**拆开再接回去逐字节等于原文**。这一条在 `--check` 里，而这台判据要做的是
// 把它压在**我们自己仓库里真实尺寸的 C** 上 —— 让"C 解析能力"的缺口暴露在我们的代码上，
// 而不是等 polydraw 那三份报错。
//
// 顺带验两件结构性的事（不靠外部工具）：
//   * 划分完整：全部切片是 `[0, len)` 的一个划分（`scanTopLevel` 里那句 assert）；
//   * 名字可用：`func` 那一族不许出现 `struct` / `__declspec` / 空名字这种"扫错了"的名字
//     —— 这三样都是真踩过的坑（见 split.js 里那两段注）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTopLevel, joinChunks, KIND } from '../../../src/core/frontend-c/split.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = (s) => process.stdout.write(s);
let pass = 0;
let fail = 0;

/* 拿**真实尺寸**的那几份（runtime 与 jit 下面的 .c）。小文件证明不了什么。 */
const dirs = ['src/runtime', 'src/jit'];
const files = [];
for (const d of dirs) {
  for (const f of readdirSync(join(ROOT, d))) {
    if (!f.endsWith('.c')) continue;
    const p = join(ROOT, d, f);
    if (statSync(p).size >= 4096) files.push(p);
  }
}
if (files.length < 5) {
  P(`  FAIL 判据自己的前提不成立：只找到 ${files.length} 份够大的 .c\n`);
  process.exit(1);
}

const BAD_NAME = new Set(['struct', 'union', 'enum', 'typedef', '__declspec', '__attribute__', '']);
for (const p of files) {
  const src = readFileSync(p, 'latin1');
  const rel = p.slice(ROOT.length + 1);
  let chunks = null;
  try {
    chunks = scanTopLevel(src);
  } catch (e) {
    fail++;
    P(`  FAIL ${rel} 扫得完\n       ${e.message}\n`);
    continue;
  }
  if (joinChunks(src, chunks) !== src) {
    fail++;
    P(`  FAIL ${rel} 接回去逐字节相同\n`);
    continue;
  }
  const bad = chunks.filter((c) => c.kind === KIND.func && BAD_NAME.has(c.name));
  if (bad.length > 0) {
    fail++;
    P(`  FAIL ${rel} 函数名都像名字\n       ${bad.length} 个可疑：`
      + `${bad.slice(0, 5).map((c) => c.name || '(空)').join(' ')}\n`);
    continue;
  }
  pass++;
  const n = chunks.filter((c) => c.kind === KIND.func).length;
  P(`  ok   ${rel} ${chunks.length} 格 / ${n} 个函数，接回去逐字节相同\n`);
}

P(`\n${pass} passed, ${fail} failed（omni c split：划分完整 + 逐字节复原）\n`);
process.exit(fail === 0 ? 0 : 1);

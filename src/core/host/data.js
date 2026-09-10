// src/core/host/data.js —— 语言插件的**数据**摆在哪（ADR-0021 的 S4）
//
// asy 的语法表（`frontend-asy/asy.grammar`）、内建绑定表、`lib/asy` 那几份都是数据，
// 不是代码。它们的落点在两种布局里不一样：
//
//   从源码跑   src/core/frontend-asy/asy.grammar   、 src/lib/asy
//   装好的样子 dist/share/frontend-asy/asy.grammar 、 dist/share/lib/asy
//
// 启动时不许要参数（`--asy-grammar=…` 那种不算数），所以按**布局**找：一串候选根，
// 命中第一个就用它。找不着的时候把试过的都印出来 —— 那句话比"找不到文件"有用得多。

import { join } from './path.js';
import { installDir, exists, cwd } from './native.js';

/** 候选根，从"装好的样子"排到"源码树" */
function dataRoots() {
  return [
    join(installDir(), 'share'),         // dist/omni -> dist/share
    join(installDir(), '..', 'share'),   // dist/bin/omni -> dist/share
    join(installDir(), '..'),            // src/core/<某一格> -> src/core
    join(installDir(), '..', '..'),      // 同上 -> src
    join(cwd(), 'dist', 'share'),
    join(cwd(), 'src', 'core'),
    join(cwd(), 'src'),
  ];
}

/**
 * 一份数据的实际路径。`rel` 是它在布局里的相对位置（`frontend-asy/asy.grammar`）。
 * 找不着交 null —— 由调用方决定那句拒绝怎么说（它知道这份数据是干什么的）。
 */
export function dataPath(rel) {
  for (const r of dataRoots()) {
    const p = join(r, rel);
    if (exists(p)) return p;
  }
  return null;
}

/** 试过哪几处（拼进"找不到"那句话里）。 */
export function dataTried(rel) {
  return dataRoots().map((r) => join(r, rel)).join('、');
}

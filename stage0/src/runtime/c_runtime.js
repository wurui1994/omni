// Omni stage0 — C 运行时的定位与拼装
//
// 运行时的 C 源码在 stage0/runtime/ 下，是**真的 C 文件**：clang 能直接检查它、ASan 能扫它、
// 可以贴进 godbolt、可以 gdb 单步。以前它是这个文件里的一个 651 行 String.raw 模板 ——
// 那样写在 C 路径自举之前还能凑合，之后不行：运行时会长成几千行，而藏在 JS 字符串里的 C
// 没有语法高亮、没有编译器检查、没法单独测。
//
// 这个模块只负责三件事：告诉编译器运行时在哪、生成的 .c 该 #include 什么、
// 以及在需要单文件时把整个运行时拼成一个翻译单元。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from '../host/path.js';
import { fileURLToPath } from 'node:url';

export const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime');

/** 生成的 .c 开头只需要这一行；其余靠 -I RUNTIME_DIR + 链接 runtimeSources() */
export const RUNTIME_INCLUDE = '#include "omni.h"';

/** 要一起喂给 cc 的运行时翻译单元 */
export function runtimeSources() {
  return readdirSync(RUNTIME_DIR)
    .filter((f) => f.endsWith('.c'))
    .sort()
    .map((f) => join(RUNTIME_DIR, f));
}

/** 把 #include "x.h" 递归展开成文件内容；已经展开过的直接删掉（等价于 include guard） */
function expand(file, seen) {
  const text = readFileSync(join(RUNTIME_DIR, file), 'utf8');
  return text.replace(/^#include "([^"]+)"[ \t]*\n/gm, (m, name) => {
    if (seen.has(name)) return '';
    seen.add(name);
    return `${expand(name, seen)}\n`;
  });
}

/**
 * 单文件模式：头 + 所有 .c 拼成一个翻译单元。
 * 能这么拼是因为运行时里没有重名的 static —— 公共函数都是 extern，只有容器宏展开出来的
 * 函数是 static，而容器只在生成的代码那一个 TU 里实例化。
 * 用途：ASan/UBSan 扫一个文件、贴 godbolt、以及"把编译结果发给别人"这种场合。
 */
export function amalgamate() {
  const seen = new Set(['omni.h']);
  const parts = [expand('omni.h', seen)];
  for (const p of runtimeSources()) parts.push(expand(basename(p), seen));
  return parts.join('\n');
}

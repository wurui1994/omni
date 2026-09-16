// Omni stage0 — C 运行时的定位与拼装
//
// 运行时的 C 源码在 src/runtime/ 下，是**真的 C 文件**：clang 能直接检查它、ASan 能扫它、
// 可以贴进 godbolt、可以 gdb 单步。以前它是这个文件里的一个 651 行 String.raw 模板 ——
// 那样写在 C 路径自举之前还能凑合，之后不行：运行时会长成几千行，而藏在 JS 字符串里的 C
// 没有语法高亮、没有编译器检查、没法单独测。
//
// 这个模块只负责三件事：告诉编译器运行时在哪、生成的 .c 该 #include 什么、
// 以及在需要单文件时把整个运行时拼成一个翻译单元。

import { readText, readDir, installDir } from '../host/native.js';
import { join, basename } from '../host/path.js';
import { dataDir } from '../host/data.js';

/* 运行时的 C 源码是**数据**（不进二进制），所以按布局找（host/data.js）：从源码跑是
   `src/runtime`，装好的样子是 `<产物同级>/share/runtime`。**认的是里头的标志文件**——
   光按目录名找会撞上 `src/core/runtime`（这个文件住的地方），量出来是
   clang 报 `'omni.h' file not found`。找不着就退回老的相对位置。 */
export const RUNTIME_DIR = dataDir('runtime', 'omni.h') ?? join(installDir(), '..', '..', 'runtime');

/**
 * ORC JIT 宿主的 C 源码（ADR-0014 决策 3 第二阶段）。
 * 和运行时分开放，因为它要 LLVM 头，而普通的 C 后端不该因此依赖 LLVM ——
 * runtimeSources() 是把 runtime/*.c **全都**喂给 cc 的，混在一起就等于强制依赖。
 */
export const JIT_DIR = dataDir('jit', 'omni_jit.c') ?? join(installDir(), '..', '..', 'jit');

/**
 * 三维那一档 OpenGL 后端（`libomnigl`）的源码目录。**故意与 RUNTIME_DIR 分开**：
 * `runtimeSources()` 那一堆是所有腿共用、连 tcc 也要编的，而这一份要 GL 那套
 * `-framework`，塞进去会把 tcc 那条腿带坏（理由写在 omni_r3_gl.c 的文件头）。
 * cli.js 单独把它编成一个动态库，运行期由 omni_r3.c dlopen；拿不到就回落 CPU 光栅器。
 */
export const GL_DIR = dataDir('runtime-gl', 'omni_gl.h') ?? join(installDir(), '..', '..', 'runtime-gl');

/**
 * **我们自己那台 C 前端自带的那几份头**（`stdbool.h`/`stddef.h`/`stdarg.h`/`float.h`）——
 * tcc 的 `{B}/include`。和运行时一样是**数据**，所以同一条规矩按布局找。
 * 摆在这儿而不是 lang/c.js 里，是因为**两处要它**：`cSysInclude()` 要拿它当第一条搜索路径，
 * 自举的布局那一步要把它抄进 `share/include`。少了后者，装好的编译器一编 C 就是
 * `omni.h:19: error: include file 'stdbool.h' not found`（第一百三十八片量到的）。
 */
export const C_INCLUDE_DIR = dataDir('include', 'stdbool.h') ?? join(installDir(), '..', '..', 'include');


/** 生成的 .c 开头只需要这一行；其余靠 -I RUNTIME_DIR + 链接 runtimeSources() */
export const RUNTIME_INCLUDE = '#include "omni.h"';

/** 要一起喂给 cc 的运行时翻译单元 */
export function runtimeSources() {
  return readDir(RUNTIME_DIR)
    .filter((f) => f.endsWith('.c'))
    .sort()
    .map((f) => join(RUNTIME_DIR, f));
}

/** 把 #include "x.h" 递归展开成文件内容；已经展开过的直接删掉（等价于 include guard） */
function expand(file, seen) {
  const text = readText(join(RUNTIME_DIR, file));
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

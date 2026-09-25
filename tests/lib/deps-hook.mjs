// Omni — 子进程的"装载过哪些模块"钩子（测试增量层用）
//
// 一句话：`node --import <这一份> …` 之后，凡是被 `load` 过的本地模块，路径都写进
// `OMNI_DEPS_OUT` 指的那份清单。测试那一层拿它当依赖集：改哪份源文件，只有装过它的用例失效。
//
// 为什么用 `module.registerHooks`（Node 22.15+ / 24+）而不是 `module.register`：前者是**同进程
// 同线程**的钩子，没有 worker、没有序列化开销 —— 这一格要在每次子进程启动时都跑，开销必须近零。
//
// 只记 `file:` 的（node: 内建与 data: 不算）。写盘攒到退出时一次 —— 一份编译器几百个模块，
// 一个模块一次 appendFileSync 是几百次系统调用。

import module from 'node:module';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

/* **老 node 上降级**：`module.registerHooks` 是 22.15+ / 23.5+ 才有的。这一份是靠
 * `--import` 装进每个子进程的，所以少了它**每一趟都在装载期就倒**，测试那层看到的是
 *   `TypeError: module.registerHooks is not a function`
 * 而不是某个用例的失败（目标机上是 v23.1.0，量到的就是这个）。
 * 没有钩子就不记依赖 —— 下面那格写不出清单时本来就有约定："当没有依赖，下一趟照旧重跑"，
 * 于是降级落在已有的安全路上，不会把缓存误判成命中。 */
const out = process.env.OMNI_DEPS_OUT;
if (out !== undefined && out !== '' && typeof module.registerHooks === 'function') {
  const seen = new Set();
  module.registerHooks({
    load(url, ctx, next) {
      if (url.startsWith('file:')) seen.add(url.slice('file://'.length));
      return next(url, ctx);
    },
  });
  process.on('exit', () => {
    try {
      appendFileSync(out, `${[...seen].join('\n')}\n`);
    } catch { /* 清单写不出去就当没有依赖：那一格下一趟照旧重跑，不会误判成命中 */ }
  });
}

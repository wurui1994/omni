// src/core/build/api.js —— **构建能力的库面**：别的项目 import 的就是这一份
//
// `build.js` 不是"我们的配置文件"，它是**一份正常的 JS**：`node build.js` 就能跑。
// 它从这儿 import 需要的东西，自己造图、自己决定跑什么 —— omni 在那个项目里只是
// 一个 npm 包（`import { Build } from 'omni-lang/build'`）。
//
//   // build.js
//   import { Build } from 'omni-lang/build';
//
//   const b = new Build();
//   b.rule('cc', { command: 'cc $cflags -c $in -o $out', description: 'CC $out' });
//   b.rule('link', { command: 'cc $in -o $out' });
//   for (const s of ['a', 'b']) b.build(`${s}.o`, 'cc', `${s}.c`);
//   b.build('app', 'link', ['a.o', 'b.o']);
//   b.default('app');
//   await b.run(process.argv.slice(2));     // 跑掉；认 -n / -j / -k / -t / --emit-ninja
//
// 所以有两种用法，而且**两种都是第一等**：
//   `node build.js`      把 omni 当库用（这个项目里可以完全没有 omni 这个命令）
//   `omni ninja`         没有 build.ninja 时它就去跑 `node build.js`（转交，不是接管）
//
// 我们不规定脚本里能写什么 —— 它是普通模块，想 import 什么、算什么、跑什么都行。

import { Builder, toNinja } from './script.js';
import { State } from './graph.js';
import { parseManifest } from './manifest.js';
import { build, BuildLog } from './run.js';
import { FakeDisk } from './plan.js';
import { runGraph } from './engine.js';

/** 造图的那几个动作（rule / build / pool / default / phony）住在 `Builder` 上。 */
export class Build extends Builder {
  /**
   * 跑一趟。`argv` 就是命令行那一串（`process.argv.slice(2)`）——
   * 与 `omni ninja` 认同一批开关，因为**它们是同一段实现**（`engine.js`）。
   * 回退出码；失败时也把 `process.exitCode` 设上，于是 `node build.js` 的退出码是对的。
   */
  run(argv) {
    const code = runGraph(this.state, argv ?? [], 'build.js');
    /* 宿主那一格（`setExitCode`）在这儿用不上：这一份可能被别人的 node 直接跑，
       那时我们不在自己的 CLI 里。`process` 有就用，没有就只回值。 */
    if (code !== 0 && typeof process !== 'undefined') process.exitCode = code;
    return code;
  }

  /** 印成一份 `.ninja`（给 CMake 那侧的生态，或者自己看）。 */
  toNinja() { return toNinja(this.state); }
}

export { Builder, toNinja, State, parseManifest, build, BuildLog, FakeDisk, runGraph };

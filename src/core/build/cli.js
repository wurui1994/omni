// src/core/build/cli.js —— `omni ninja`：构建引擎的命令行入口
//
//   omni ninja [-f FILE] [-j N] [-n] [-k] [-t TOOL] [目标…]
//
// `FILE` 不给时按次序找：`build.ninja` → `build.js`。**两种入口的地位不同**：
//
//   `.ninja`  我们自己读（`manifest.js`），然后交给 `engine.js` 跑
//   `.js`     **转交给 node 跑它**（`node build.js …`）—— 它是一份正常的 JS，
//             自己 import 我们的构建能力（`api.js`），自己决定跑什么。
//             这个目录里有没有 omni 这个命令都不影响它能跑。
//
// 转交而不是"我们把它 import 进来求值"的理由：那份脚本是**别人的程序**，
// 它的依赖、它的 node 版本、它自己的命令行参数都该归它自己。我们只是把
// 目标与开关原样递过去，退出码原样带回来。

import { readText, exists, stderr, spawn, cwd } from '../host/native.js';
import { join, isAbsolute, dirname } from '../host/path.js';
import { State } from './graph.js';
import { parseManifest } from './manifest.js';
import { runGraph, argOf } from './engine.js';

/** 读一份 manifest 到图上。`include` / `subninja` 相对它自己的目录找。 */
export function loadManifest(path) {
  const abs = isAbsolute(path) ? path : join(cwd(), path);
  if (!exists(abs)) throw new Error(`omni ninja：找不到 ${path}`);
  const state = new State();
  const base = dirname(abs);
  parseManifest(state, readText(abs), path, {
    readFile: (p) => readText(isAbsolute(p) ? p : join(base, p)),
  });
  return state;
}

/** `omni ninja` 的正主。回退出码。 */
export function ninjaCmd(argv) {
  const given = argOf(argv, '-f') ?? argOf(argv, '--file');
  let path = given;
  if (path === null) {
    if (exists(join(cwd(), 'build.ninja'))) path = 'build.ninja';
    else if (exists(join(cwd(), 'build.js'))) path = 'build.js';
    else {
      stderr('omni ninja：这个目录里没有 build.ninja 也没有 build.js（用 -f 指一份）\n');
      return 2;
    }
  }
  if (path.endsWith('.js') || path.endsWith('.mjs')) return handOffToNode(path, argv, given);
  const state = loadManifest(path);
  return runGraph(state, argv, path);
}

/**
 * 把这一趟**原样转交**给 `node build.js`：去掉 `-f FILE` 那两格（它已经变成要跑的文件），
 * 其余开关与目标一个不动。退出码照搬。
 */
function handOffToNode(path, argv, given) {
  const abs = isAbsolute(path) ? path : join(cwd(), path);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (given !== null && (argv[i] === '-f' || argv[i] === '--file')) { i++; continue; }
    rest.push(argv[i]);
  }
  /* `'i'` = 三个流全直通：那份脚本自己印进度、自己印错误，我们不插手也不缓冲。 */
  const [status] = spawn('node', [abs, ...rest], 'i');
  return status;
}

/** 给诊断用：这一趟会拿哪份入口（没有就 null）。 */
export function ninjaEntry() {
  if (exists(join(cwd(), 'build.ninja'))) return 'build.ninja';
  if (exists(join(cwd(), 'build.js'))) return 'build.js';
  return null;
}

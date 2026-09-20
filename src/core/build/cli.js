// src/core/build/cli.js —— `omni ninja`：构建引擎的命令行入口
//
//   omni ninja [-f FILE] [-j N] [-n] [-k] [-t TOOL] [目标…]
//
// `FILE` 不给时按次序找：`build.ninja` → `build.js`。两种入口造出来的是**同一张图**
// （`script.js` 的头上写了为什么描述用 `build.js` 而不是第三门 DSL）。
//
// `.js` 那条路要先把脚本跑一遍才知道图长什么样，而脚本是普通 ESM（想 import 什么都行，
// 我们不限制它做什么）—— ESM 的 `import()` 是异步的，而这一层的驱动是同步的。
// 所以 `.js` 走**一个子进程**：让 node 把脚本求值成一份 manifest 文本，父进程照
// `.ninja` 那条路读它。代价是每趟多一个进程（量过：~60ms），换来的是"一台引擎、
// 两种入口、同一个解析器"，也换来脚本不受限。
//
// 工具（`-t`）：`commands` 印命令、`targets` 印目标、`graph` 出 dot、`clean` 删产物。
// 这四个是真用得上的；`browse` / `msvc` 那一族不接（设计文档第 10 节）。

import {
  readText, writeText, exists, mtimeMs, stdout, stderr, spawn, cwd, installDir, env,
} from '../host/native.js';
import { join, isAbsolute, dirname } from '../host/path.js';
import { State, describeEdge } from './graph.js';
import { parseManifest } from './manifest.js';
import { build, BuildLog } from './run.js';
import { recomputeDirty } from './plan.js';

/** 一格 `-x VALUE`。 */
function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** 真磁盘。**只有这一格碰文件系统**（判据里换 FakeDisk）。 */
const REAL_DISK = {
  stat(path) {
    try { return mtimeMs(path); } catch { return 0; }
  },
};

/**
 * 工具指纹：**编译器自己变了，命令没变也要重做**（学 Go 的 action ID）。
 * 现在取的是入口那份文件的 mtime —— 便宜且够用；等动作缓存进来换成内容哈希。
 */
function toolFingerprint() {
  const fromEnv = env('OMNI_BUILD_FINGERPRINT');
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try { return String(mtimeMs(join(installDir(), 'cli.js'))); } catch { return 'dev'; }
}

/**
 * 把一份 `build.js` 变成 manifest 文本 —— 在**子进程**里求值（理由见文件头）。
 * 子进程用的是这棵树里的 `script.js`，所以两条入口共用同一份 Builder 与同一个印法。
 */
export function ninjaTextOfScript(scriptPath) {
  const abs = isAbsolute(scriptPath) ? scriptPath : join(cwd(), scriptPath);
  /* `installDir()` 是宿主那一格所在的目录（`src/core/host`），`build/` 与它同级 ——
     两种布局（源码树与装好的那份）里这条关系都成立，所以只数这一层 `..`。 */
  const scriptMod = join(installDir(), '..', 'build', 'script.js');
  if (!exists(scriptMod)) {
    throw new Error(`omni ninja：找不到 ${scriptMod} —— build.js 这条路要它（.ninja 那条不用）`);
  }
  const code = `import { loadBuildScript, toNinja } from ${JSON.stringify(`file://${scriptMod}`)};`
    + `const st = await loadBuildScript(${JSON.stringify(abs)});`
    + 'process.stdout.write(toNinja(st));';
  const [status, out, err] = spawn('node', ['--input-type=module', '-e', code], 'c');
  if (status !== 0) {
    throw new Error(`${scriptPath}: 这份构建描述跑出错了\n${(err ?? '').trim() || (out ?? '').trim()}`);
  }
  return out;
}

/** 读入口：`-f` 给的那份，或 `build.ninja` → `build.js`。回 `{state, path}`。 */
export function loadGraph(argv) {
  const given = argOf(argv, '-f') ?? argOf(argv, '--file');
  let path = given;
  if (path === null) {
    if (exists(join(cwd(), 'build.ninja'))) path = 'build.ninja';
    else if (exists(join(cwd(), 'build.js'))) path = 'build.js';
    else {
      throw new Error('omni ninja：这个目录里没有 build.ninja 也没有 build.js（用 -f 指一份）');
    }
  }
  const abs = isAbsolute(path) ? path : join(cwd(), path);
  if (!exists(abs)) throw new Error(`omni ninja：找不到 ${path}`);
  const state = new State();
  const text = path.endsWith('.js') ? ninjaTextOfScript(abs) : readText(abs);
  const base = dirname(abs);
  parseManifest(state, text, path, {
    readFile: (p) => readText(isAbsolute(p) ? p : join(base, p)),
  });
  return { state, path, text };
}

/** `omni ninja` 的正主。回退出码。 */
export function ninjaCmd(argv) {
  const { state, path, text } = loadGraph(argv);
  const targets = argv.filter((a, i) => !a.startsWith('-')
    && argv[i - 1] !== '-f' && argv[i - 1] !== '--file'
    && argv[i - 1] !== '-j' && argv[i - 1] !== '-t');

  const tool = argOf(argv, '-t');
  if (argv.includes('--emit-ninja')) { stdout(text); return 0; }
  if (tool !== null) return runTool(tool, state, targets, text);

  const jobs = Number(argOf(argv, '-j') ?? '1');
  const logPath = join(cwd(), '.omni_log');
  /* 两行而不是三元：惰性位置上的临时量我们自己那台编译器不收（它让你抬成语句）。 */
  let log = new BuildLog();
  if (exists(logPath)) log = BuildLog.parse(readText(logPath));
  const r = build(state, {
    disk: REAL_DISK,
    log,
    targets,
    toolFingerprint: toolFingerprint(),
    dryRun: argv.includes('-n'),
    keepGoing: argv.includes('-k'),
    jobs,
    say: (s) => stderr(`${s}\n`),
    now: () => Date.now(),
    exec: (cmd) => {
      const [status, out, err] = spawn('sh', ['-c', cmd], 'c');
      return { code: status, out: `${out ?? ''}${err ?? ''}` };
    },
  });
  if (!argv.includes('-n')) writeText(logPath, log.text());
  if (r.failed.length > 0) {
    stderr(`omni ninja: ${r.failed.length} 条命令失败（${path}）\n`);
    return 1;
  }
  if (r.ran.length === 0) stderr(`omni ninja: 没什么要做的（${path}）\n`);
  return 0;
}

/** `-t` 那几格。**声明了就得能用** —— 所以只列真的实现了的。 */
function runTool(tool, state, targets, text) {
  if (tool === 'commands') {
    /* 按拓扑序印命令（照 ninja：依赖在前），空 targets = default */
    const roots = targets.length > 0
      ? targets.map((t) => state.node(t, false)).filter((n) => n !== null)
      : state.defaultTargets();
    const seen = new Set();
    const walk = (node) => {
      const e = node.inEdge;
      if (e === null || seen.has(e)) return;
      seen.add(e);
      for (const inp of e.inputs) walk(inp);
      if (!e.isPhony()) stdout(`${e.command()}\n`);
    };
    for (const n of roots) walk(n);
    return 0;
  }
  if (tool === 'targets') {
    for (const e of state.edges) {
      for (const out of e.explicitOutputs()) stdout(`${out.path}: ${e.rule.name}\n`);
    }
    return 0;
  }
  if (tool === 'graph') {
    stdout('digraph omni {\nrankdir="LR"\nnode [fontsize=10, shape=box]\n');
    for (const e of state.edges) {
      const label = e.rule === null ? '?' : e.rule.name;
      const id = `e${e.id}`;
      stdout(`"${id}" [label="${label}", shape=ellipse]\n`);
      for (let i = 0; i < e.inputs.length; i++) {
        const style = e.isOrderOnlyIndex(i) ? ' [style=dotted]'
          : (e.isImplicitIndex(i) ? ' [style=dashed]' : '');
        stdout(`"${e.inputs[i].path}" -> "${id}"${style}\n`);
      }
      for (const out of e.outputs) stdout(`"${id}" -> "${out.path}"\n`);
    }
    stdout('}\n');
    return 0;
  }
  if (tool === 'clean') {
    let n = 0;
    for (const e of state.edges) {
      if (e.isPhony()) continue;
      for (const out of e.outputs) {
        if (!exists(out.path)) continue;
        /* 删产物**只删图里说的那些**，绝不按模式匹配（删错东西是不可逆的） */
        spawn('rm', ['-f', out.path], 'c');
        n++;
      }
    }
    stderr(`omni ninja -t clean: 删了 ${n} 个产物\n`);
    return 0;
  }
  if (tool === 'dirty') {
    /* 我们自己加的一格：**印出脏判定的结论与理由**。ninja 没有这个，
       而"为什么它又要重编"是这类系统里最常问的一句。 */
    const roots = targets.length > 0 ? targets : state.defaultTargets().map((n) => n.path);
    const lp = join(cwd(), '.omni_log');
    let log = new BuildLog();
    if (exists(lp)) log = BuildLog.parse(readText(lp));
    recomputeDirty(state, REAL_DISK, log, roots, { toolFingerprint: toolFingerprint() });
    for (const e of state.edges) {
      const d = e.outputs.some((o) => o.dirty);
      stdout(`${d ? '脏' : '新'}  ${describeEdge(e)}\n`);
    }
    return 0;
  }
  stderr(`omni ninja -t ${tool}：没有这一格 —— 有 commands / targets / graph / clean / dirty\n`);
  return 2;
}

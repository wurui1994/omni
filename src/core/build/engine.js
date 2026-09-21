// src/core/build/engine.js —— 把一张图跑完的那一段（`omni ninja` 与 `node build.js` 共用）
//
// 为什么单独一份：两个入口（我们的 CLI、别人的 `node build.js`）必须是**同一段实现**，
// 不然"两种用法行为一样"就只是句话。开关、日志落点、退出码全在这儿定一次。
//
//   -n            只印要跑什么
//   -j N          并发上限（现在一次一条，见 docs/design/build-system.md §9）
//   -k            一条失败了接着跑别的
//   -t TOOL       commands | targets | graph | clean | dirty
//   --emit-ninja  把图印成 .ninja
//   别的位置参数  = 目标（不给就用 default）

import {
  readText, writeText, exists, mtimeMs, stdout, stderr, spawn, cwd, installDir, env,
} from '../host/native.js';
import { join } from '../host/path.js';
import { describeEdge } from './graph.js';
import { build, BuildLog } from './run.js';
import { recomputeDirty } from './plan.js';
import { toNinja } from './script.js';

/** 一格 `-x VALUE`。 */
export function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** 真磁盘。**只有这一格碰文件系统**（判据里换 FakeDisk）。 */
export const REAL_DISK = {
  stat(path) {
    try { return mtimeMs(path); } catch { return 0; }
  },
};

/**
 * 工具指纹：**编译器自己变了，命令没变也要重做**（学 Go 的 action ID）。
 * 现在取的是入口那份文件的 mtime —— 便宜且够用；等动作缓存进来换成内容哈希。
 * 别的项目把 omni 当库用时，用 `OMNI_BUILD_FINGERPRINT` 指自己的那份。
 */
export function toolFingerprint() {
  const fromEnv = env('OMNI_BUILD_FINGERPRINT');
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try { return String(mtimeMs(join(installDir(), 'cli.js'))); } catch { return 'dev'; }
}

/** 位置参数 = 目标（把带值的开关那一格跳掉）。 */
function targetsOf(argv) {
  const skipAfter = ['-f', '--file', '-j', '-t'];
  return argv.filter((a, i) => !a.startsWith('-') && !skipAfter.includes(argv[i - 1]));
}

/**
 * 跑一张图。回退出码（0 通 / 1 有命令失败 / 2 开关说不通）。
 *
 * @param {import('./graph.js').State} state
 * @param {string[]} argv 命令行那一串
 * @param {string} label 报错里印的入口名字（`build.js` / `build.ninja`）
 */
export function runGraph(state, argv, label) {
  const targets = targetsOf(argv);
  if (argv.includes('--emit-ninja')) { stdout(toNinja(state)); return 0; }
  const tool = argOf(argv, '-t');
  if (tool !== null) return runTool(tool, state, targets);

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
    jobs: Number(argOf(argv, '-j') ?? '1'),
    say: (s) => stderr(`${s}\n`),
    now: () => Date.now(),
    exec: (cmd) => {
      const [status, out, err] = spawn('sh', ['-c', cmd], 'c');
      return { code: status, out: `${out ?? ''}${err ?? ''}` };
    },
  });
  if (!argv.includes('-n')) writeText(logPath, log.text());
  if (r.failed.length > 0) {
    stderr(`build: ${r.failed.length} 条命令失败（${label}）\n`);
    return 1;
  }
  if (r.ran.length === 0) stderr(`build: 没什么要做的（${label}）\n`);
  return 0;
}

/** `-t` 那几格。**声明了就得能用** —— 所以只列真的实现了的。 */
export function runTool(tool, state, targets) {
  if (tool === 'commands') {
    /* 按拓扑序印命令（依赖在前）；不给目标就用 default */
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
      const id = `e${e.id}`;
      stdout(`"${id}" [label="${e.rule === null ? '?' : e.rule.name}", shape=ellipse]\n`);
      for (let i = 0; i < e.inputs.length; i++) {
        let style = '';
        if (e.isOrderOnlyIndex(i)) style = ' [style=dotted]';
        else if (e.isImplicitIndex(i)) style = ' [style=dashed]';
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
    stderr(`-t clean: 删了 ${n} 个产物\n`);
    return 0;
  }
  if (tool === 'dirty') {
    /* 我们自己加的一格：**印出脏判定的结论**。ninja 没有这个，
       而"为什么它又要重编"是这类系统里最常问的一句。 */
    const roots = targets.length > 0 ? targets : state.defaultTargets().map((n) => n.path);
    const lp = join(cwd(), '.omni_log');
    let log = new BuildLog();
    if (exists(lp)) log = BuildLog.parse(readText(lp));
    recomputeDirty(state, REAL_DISK, log, roots, { toolFingerprint: toolFingerprint() });
    for (const e of state.edges) {
      let d = false;
      for (const o of e.outputs) if (o.dirty) d = true;
      stdout(`${d ? '脏' : '新'}  ${describeEdge(e)}\n`);
    }
    return 0;
  }
  stderr(`-t ${tool}：没有这一格 —— 有 commands / targets / graph / clean / dirty\n`);
  return 2;
}

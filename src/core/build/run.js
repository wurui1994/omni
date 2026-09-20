// src/core/build/run.js —— 把计划跑完（照 `reference/ninja/src/build.cc` 的 Builder）
//
// 三件事：**一份日志**（上一趟的命令哈希与耗时）、**一个执行器**（命令怎么跑）、
// **一个主循环**（取就绪的边 → 跑 → 记 → 把下游放进就绪）。
//
// 执行器是**注入**的（ninja 的 `CommandRunner` 接口同一个用意）：判据里换成假的，
// 就能跑一整趟构建而不起一个进程，于是"跑了哪些命令、什么次序、第二趟跑几条"
// 变成可比的数据。这是这一层唯一的判据形态 —— 拿墙上时间比构建系统是自欺。

import { recomputeDirty, Plan, commandHash } from './plan.js';
import { describeEdge } from './graph.js';

/**
 * `.omni_log`：**上一趟每个输出是用什么命令做出来的**（加耗时，给关键路径用）。
 *
 * 格式照 ninja 的 `.ninja_log`（`build_log.cc:53`）一行一格、追加写、
 * 偶尔重写压缩：`start<TAB>end<TAB>mtime<TAB>output<TAB>hash`。
 * 为什么是文本：这份要能被人直接翻（"上次这个 .o 是用哪条命令做的"是最常问的一句）。
 */
export class BuildLog {
  constructor() {
    /** @type {Map<string, {start:number,end:number,mtime:number,hash:string}>} */
    this.entries = new Map();
    this.dirtyCount = 0;
  }

  static header() { return '# omni build log v1'; }

  /** 从文本读回来。坏行**跳过**而不是报错：日志是可重建的，不该因为它挡住构建。 */
  static parse(text) {
    const log = new BuildLog();
    if (text === null || text === undefined) return log;
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length !== 5) continue;
      log.entries.set(f[3], {
        start: Number(f[0]), end: Number(f[1]), mtime: Number(f[2]), hash: f[4],
      });
    }
    return log;
  }

  text() {
    const out = [BuildLog.header()];
    for (const [path, e] of this.entries) {
      out.push(`${e.start}\t${e.end}\t${e.mtime}\t${path}\t${e.hash}`);
    }
    return `${out.join('\n')}\n`;
  }

  hashOf(path) {
    const e = this.entries.get(path);
    return e === undefined ? null : e.hash;
  }

  /** 上一趟这条边花了多少毫秒（关键路径按它排；不知道回 null）。 */
  elapsedOf(edge) {
    for (const out of edge.outputs) {
      const e = this.entries.get(out.path);
      if (e !== undefined) return e.end - e.start;
    }
    return null;
  }

  record(edge, hash, start, end, mtimeOf) {
    for (const out of edge.outputs) {
      this.entries.set(out.path, { start, end, mtime: mtimeOf(out.path), hash });
      this.dirtyCount++;
    }
  }
}

/**
 * 跑一趟。
 *
 * @param {import('./graph.js').State} state
 * @param {{
 *   disk: {stat: (p:string)=>number},
 *   log?: BuildLog,
 *   targets?: string[],
 *   exec?: (cmd: string, edge: any) => {code:number, out?:string},
 *   toolFingerprint?: string,
 *   dryRun?: boolean,
 *   jobs?: number,
 *   say?: (s: string) => void,
 *   now?: () => number,
 * }} opts
 * @returns {{ran: string[], skipped: number, failed: string[], commandEdges: number}}
 *
 * `ran` 是**按次序**跑过的命令 —— 判据比的就是它（与真 ninja 比同一份 manifest 的
 * 命令集合与次序）。`jobs` 现在只影响"一轮取几条"的上限：进程是一条一条起的
 * （宿主那侧只有同步 spawn），真并行留给下一刀，那一格在设计文档第 9 节记着。
 */
export function build(state, opts) {
  const disk = opts.disk;
  /* 两行而不是 `??`：惰性位置上的临时量我们自己那台编译器不收（它让你抬成语句）。 */
  let log = opts.log;
  if (log === undefined || log === null) log = new BuildLog();
  const say = opts.say ?? (() => {});
  const now = opts.now ?? (() => 0);
  const fp = opts.toolFingerprint ?? '';
  const targets = (opts.targets !== undefined && opts.targets.length > 0)
    ? opts.targets : state.defaultTargets().map((n) => n.path);

  const roots = recomputeDirty(state, disk, log, targets, { toolFingerprint: fp });
  const plan = new Plan();
  for (const n of roots) plan.addTarget(n);
  plan.computeCriticalPath((e) => log.elapsedOf(e));
  plan.prepareQueue();

  const total = plan.commandEdges;
  const ran = [];
  const failed = [];
  let done = 0;

  for (;;) {
    const edge = plan.findWork();
    if (edge === null) break;
    if (edge.isPhony()) {
      plan.edgeFinished(edge, true, true);
      continue;
    }
    const cmd = edge.command();
    const before = edge.outputs.map((n) => disk.stat(n.path));
    done++;
    const desc = edge.binding('description');
    say(`[${done}/${total}] ${desc === '' ? cmd : desc}`);
    ran.push(cmd);
    if (opts.dryRun === true) {
      plan.edgeFinished(edge, true, true);
      continue;
    }
    const start = now();
    const r = (opts.exec ?? (() => ({ code: 0 })))(cmd, edge);
    const end = now();
    if (r.out !== undefined && r.out !== '') say(r.out.replace(/\n$/, ''));
    if (r.code !== 0) {
      failed.push(cmd);
      say(`build: 这条命令回了 ${r.code}：${cmd}\n    它要造的是：${describeEdge(edge)}`);
      plan.edgeFinished(edge, false, false);
      if (opts.keepGoing !== true) break;
      continue;
    }
    /* 输出真的变了吗（restat）：mtime 没前进就说明内容没变，下游可以摘掉。 */
    let changed = false;
    for (let i = 0; i < edge.outputs.length; i++) {
      const n = edge.outputs[i];
      n.mtime = -1;
      const after = disk.stat(n.path);
      n.mtime = after;
      n.exists = after === 0 ? 1 : 2;
      if (after !== before[i]) changed = true;
    }
    const restat = edge.binding('restat') !== '';
    log.record(edge, commandHash(cmd, fp), start, end, (p) => disk.stat(p));
    plan.edgeFinished(edge, true, restat ? changed : true, (next) => edgeStillDirty(next, disk, log, fp));
  }

  return { ran, failed, commandEdges: total, skipped: total - done, log };
}

/**
 * 重判一条边脏不脏（restat 摘下游时用）。判的与第一遍同一套：
 * 输出缺了 / 比某个非仅次序的输入旧 / 命令哈希与上一趟不同。
 */
function edgeStillDirty(edge, disk, log, fp) {
  if (edge.isPhony()) return false;
  let newest = 0;
  for (let i = 0; i < edge.inputs.length; i++) {
    if (edge.isOrderOnlyIndex(i)) continue;
    const m = disk.stat(edge.inputs[i].path);
    if (m > newest) newest = m;
  }
  const want = commandHash(edge.command(), fp);
  for (const out of edge.outputs) {
    const m = disk.stat(out.path);
    if (m === 0) return true;
    if (m < newest) return true;
    const had = log.hashOf(out.path);
    if (had === null || had !== want) return true;
  }
  return false;
}

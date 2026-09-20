// src/core/build/plan.js —— 脏判定与构建计划（照 `reference/ninja/src/graph.cc` + `build.cc`）
//
// 两件事，刻意分开：
//
//   1. **脏判定**（`recomputeDirty`）：一格输出要不要重做。三个来源合起来判，
//      少一个就会给错答案 ——
//        a. mtime：输出不存在、或比任一输入旧 → 脏
//        b. 命令哈希：命令变了 → 脏（这一条靠 `.omni_log` 记上一趟跑的是什么）
//        c. 上游脏：输入本身要重做 → 它也脏
//      `docs/design/build-system.md` 第 5 节说了为什么我们的命令哈希里还要掺
//      **工具指纹**：改一行后端而命令字面量不变，是这棵树上最常见的情形。
//   2. **计划**（`Plan`）：要做哪些、次序怎么排。`want_` 三态 + 就绪优先队列，
//      键是关键路径权重 —— 长链先开工，不然串行那一段会挤到最后。
//
// 与 ninja 的差别只有一处（约束 2）：**缺输入就是错误**。ninja 允许"没有规则造它、
// 但文件不存在"时按 phony 兜底，我们报出"谁要它"。

import { assertAcyclic, describeEdge, EXIST_MISSING, EXIST_YES } from './graph.js';

/** want 的三态（`build.h:96` 的 `Plan::Want`）。 */
export const WANT_NOTHING = 0;
export const WANT_TO_START = 1;
export const WANT_TO_FINISH = 2;

/**
 * 磁盘接口。**只有这一格碰文件系统** —— 判据里换成假的就能跑一整趟构建而不动磁盘
 * （ninja 的 `DiskInterface` 同一个用法，`build_test.cc` 4639 行全靠它）。
 */
export class DiskInterface {
  constructor(host) {
    this.host = host;
  }

  /** 回 mtime（毫秒）；不存在回 0。 */
  stat(path) {
    const ms = this.host.mtimeMs(path);
    return ms === null || ms === undefined || Number.isNaN(ms) ? 0 : ms;
  }
}

/** 假磁盘：`{path: mtime}`，判据用。 */
export class FakeDisk {
  constructor(files) {
    this.files = new Map(Object.entries(files ?? {}));
    this.now = 1000;
  }

  stat(path) { return this.files.get(path) ?? 0; }

  /** 跑完一条命令之后，产物"被写出来"——判据里手动推时间。 */
  touch(path, at) {
    this.now = at ?? this.now + 1;
    this.files.set(path, this.now);
    return this.now;
  }
}

/**
 * 脏判定。走一遍以目标为根的 DFS，给每格 Node 填 `dirty`、给每条边填 `outputsReady`。
 *
 * @param {import('./graph.js').State} state
 * @param {{stat: (p: string) => number}} disk
 * @param {{hashOf: (out: string) => (string|null)}} log 上一趟的命令哈希（`.omni_log`）
 * @param {string[]} targets 目标路径
 * @param {{ toolFingerprint?: string }} [opts]
 */
export function recomputeDirty(state, disk, log, targets, opts) {
  const nodes = targets.map((t) => {
    const n = state.node(t, false);
    if (n === null) throw new Error(`build: 没有谁造 '${t}'，也没有这个文件`);
    return n;
  });
  assertAcyclic(state, nodes);
  const seen = new Set();
  for (const n of nodes) visitNode(state, disk, log, n, seen, opts ?? {});
  return nodes;
}

function statNode(disk, node) {
  if (node.mtime !== -1) return;
  const m = disk.stat(node.path);
  node.mtime = m;
  node.exists = m === 0 ? EXIST_MISSING : EXIST_YES;
}

/**
 * 一格节点：先把造它那条边的输入都走完，再判自己脏不脏。
 * 回"这格是不是脏的"。
 */
function visitNode(state, disk, log, node, seen, opts) {
  const edge = node.inEdge;
  if (edge === null) {
    /* 源文件：不存在就是错误，且要说清谁要它（约束 2：不许 weak 兜底） */
    statNode(disk, node);
    if (!node.existsOnDisk()) {
      const who = node.outEdges.length > 0 ? describeEdge(node.outEdges[0]) : '（没人要它）';
      throw new Error(`build: 缺了输入 '${node.path}'\n    要它的是：${who}`);
    }
    node.dirty = false;
    return false;
  }
  if (seen.has(edge)) return node.dirty;
  seen.add(edge);

  let anyInputDirty = false;
  let newestInput = 0;
  for (let i = 0; i < edge.inputs.length; i++) {
    const inp = edge.inputs[i];
    const d = visitNode(state, disk, log, inp, seen, opts);
    /* **仅次序的输入不参与脏判定**（只排次序）—— 这是 `||` 与 `|` 的唯一区别 */
    if (edge.isOrderOnlyIndex(i)) continue;
    if (d) anyInputDirty = true;
    if (inp.mtime > newestInput) newestInput = inp.mtime;
  }

  const cmd = edge.isPhony() ? '' : edge.command();
  const want = edge.isPhony() ? null : commandHash(cmd, opts.toolFingerprint ?? '');
  let dirty = anyInputDirty;
  for (const out of edge.outputs) {
    statNode(disk, out);
    if (!out.existsOnDisk()) { dirty = true; continue; }
    if (out.mtime < newestInput) dirty = true;
    if (want !== null) {
      const had = log.hashOf(out.path);
      /* 没记过 = 不知道上次用什么命令做的 → 重做（宁可多做一次，不给错答案） */
      if (had === null || had !== want) dirty = true;
    }
  }
  /* phony 的 mtime 是"依赖里最新的那个"（ninja 的 UpdatePhonyMtime）：
     它自己没有内容，但下游要拿它比。 */
  if (edge.isPhony()) {
    for (const out of edge.outputs) if (out.mtime < newestInput) out.mtime = newestInput;
  }
  for (const out of edge.outputs) out.dirty = dirty;
  edge.outputsReady = !dirty;
  return dirty;
}

/**
 * 命令哈希。**掺进工具指纹**：改一行 `backend-c/emit.js` 时命令字面量往往不变，
 * 而产物必须重做 —— 那一格漏了就是"改了编译器却没重编"这种静默的错答案（学 Go 的 action ID）。
 */
export function commandHash(cmd, toolFingerprint) {
  let h = 0x811c9dc5;
  const s = `${toolFingerprint}\u0000${cmd}`;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 构建计划：**要做哪些边、什么次序**。
 *
 * `want` 三态照 ninja（`build.h:96`）：`NOTHING` 是"它自己不用做，但它的下游可能要做"——
 * 少了这一态就分不开"已经是新的"与"根本不在这趟里"。
 *
 * 就绪队列按**关键路径权重**取（大的先）；同权重按边 id —— 次序必须是确定的，
 * 不然两趟构建的命令次序不同，判据就没法比。
 */
export class Plan {
  constructor() {
    /** @type {Map<import('./graph.js').Edge, number>} */
    this.want = new Map();
    /** @type {import('./graph.js').Edge[]} 就绪集合（取的时候挑最大权重） */
    this.ready = [];
    this.commandEdges = 0;
    this.wantedEdges = 0;
  }

  /** 把一格目标加进计划（递归往上游要）。脏判定必须已经跑过。 */
  addTarget(node) {
    this.addSubTarget(node, null);
  }

  addSubTarget(node, dependent) {
    const edge = node.inEdge;
    if (edge === null) {
      /* 源文件；缺了在脏判定那一步已经报过 */
      return;
    }
    if (!node.dirty) {
      /* 已经是新的：它自己不做，但它可能还要被别人等（`WANT_NOTHING`） */
      if (!this.want.has(edge)) this.want.set(edge, WANT_NOTHING);
      return;
    }
    const had = this.want.get(edge);
    if (had === undefined) {
      this.want.set(edge, WANT_TO_START);
      this.wantedEdges++;
      if (!edge.isPhony()) this.commandEdges++;
    } else if (had === WANT_NOTHING) {
      this.want.set(edge, WANT_TO_START);
      this.wantedEdges++;
      if (!edge.isPhony()) this.commandEdges++;
    } else {
      return; // 已经要做了，不必再走一遍上游
    }
    for (const inp of edge.inputs) this.addSubTarget(inp, node);
    for (const v of edge.validations) this.addSubTarget(v, node);
  }

  /**
   * 算关键路径权重：一条边的权重 = 它自己的代价 + 下游里最大的那个。
   * 代价现在按"一条命令 = 1"算；`.omni_log` 里有上一趟耗时的话用它（更准）。
   */
  computeCriticalPath(prevElapsed) {
    const weightOf = (edge) => {
      if (edge.criticalPathWeight >= 0) return edge.criticalPathWeight;
      /* 先占位防自引用（图已经查过无环，这一格只是保险） */
      edge.criticalPathWeight = 0;
      let best = 0;
      for (const out of edge.outputs) {
        for (const next of out.outEdges) {
          if (!this.want.has(next)) continue;
          const w = weightOf(next);
          if (w > best) best = w;
        }
      }
      const self = edge.isPhony() ? 0
        : (prevElapsed === undefined ? 1 : (prevElapsed(edge) ?? 1));
      edge.criticalPathWeight = best + self;
      return edge.criticalPathWeight;
    };
    for (const e of this.want.keys()) e.criticalPathWeight = -1;
    for (const e of this.want.keys()) weightOf(e);
  }

  /** 把"要做且输入都就绪"的边放进就绪集合。 */
  prepareQueue() {
    this.computeCriticalPath();
    for (const [edge, w] of this.want) {
      if (w === WANT_TO_START && edge.allInputsReady()) this.ready.push(edge);
    }
  }

  /**
   * 取一条能跑的边：**权重大的先**，同权重按 id（次序确定）。
   * 池满的边这一轮跳过（等别的做完再来）。回 `null` = 现在没得跑。
   */
  findWork() {
    let best = -1;
    let at = -1;
    for (let i = 0; i < this.ready.length; i++) {
      const e = this.ready[i];
      if (!e.pool.hasRoom()) continue;
      if (e.criticalPathWeight > best
          || (e.criticalPathWeight === best && at >= 0 && e.id < this.ready[at].id)) {
        best = e.criticalPathWeight;
        at = i;
      }
    }
    if (at === -1) return null;
    const edge = this.ready.splice(at, 1)[0];
    this.want.set(edge, WANT_TO_FINISH);
    edge.pool.currentUse++;
    return edge;
  }

  /** 还有没有要做的（含在跑的）。 */
  moreToDo() { return this.wantedEdges > 0; }

  /**
   * 一条边做完了。`outputsChanged === false` 时走 **restat** 那条路：
   * 输出内容没变（mtime 没前进）→ 下游从"要做"降回"不用做"。
   * 链接那一步最吃这一条：改一行注释重编了 `.o` 但字节没变，就不该重链。
   */
  edgeFinished(edge, ok, outputsChanged, recheck) {
    edge.pool.currentUse--;
    const had = this.want.get(edge);
    if (had === WANT_TO_FINISH || had === WANT_TO_START) this.wantedEdges--;
    this.want.set(edge, WANT_NOTHING);
    if (!ok) return;
    edge.outputsReady = true;
    for (const out of edge.outputs) {
      out.dirty = false;
      this.nodeFinished(out);
    }
    /* restat：产物没变 → 下游**如果自己没有别的理由**就摘掉。
       "别的理由"必须**重新判一次**（mtime 与命令哈希），不能只看"别的输入脏不脏" ——
       源文件永远不脏，可它比产物新的时候下游是真要重做的。少这一次重判，
       判据里那条 restat 会把该跑的 `cc` 也摘掉（量过）。 */
    if (outputsChanged === false && recheck !== undefined) {
      for (const out of edge.outputs) this.cleanDownstream(out, recheck);
    }
  }

  nodeFinished(node) {
    for (const next of node.outEdges) {
      const w = this.want.get(next);
      if (w !== WANT_TO_START) continue;
      if (!next.allInputsReady()) continue;
      if (!this.ready.includes(next)) this.ready.push(next);
    }
    for (const next of node.validationOutEdges) {
      const w = this.want.get(next);
      if (w === WANT_TO_START && next.allInputsReady() && !this.ready.includes(next)) {
        this.ready.push(next);
      }
    }
  }

  /** restat 的下半截：把"自己已经不脏了"的下游摘掉（`recheck` 重判一次）。 */
  cleanDownstream(node, recheck) {
    for (const next of node.outEdges) {
      if (this.want.get(next) !== WANT_TO_START) continue;
      if (recheck(next)) continue;            // 它自己还是脏的 —— 留着
      this.want.set(next, WANT_NOTHING);
      this.wantedEdges--;
      if (!next.isPhony()) this.commandEdges--;
      const at = this.ready.indexOf(next);
      if (at >= 0) this.ready.splice(at, 1);
      next.outputsReady = true;
      for (const out of next.outputs) {
        out.dirty = false;
        this.nodeFinished(out);
        this.cleanDownstream(out, recheck);
      }
    }
  }
}

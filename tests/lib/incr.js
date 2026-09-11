// Omni — 测试轴的增量层
//
// 一句话：**贵的那一步是子进程**。一条用例六条腿，每条腿一次 `node src/core/cli.js …`，
// 每次都把整份编译器（十来兆 JS）重新装一遍 —— 一条 jnc 轴五百多次进程启动，两分钟里绝大
// 多数时间花在"装同一份编译器"上，而输入常常一个字都没变。
//
// 这一层把那一步做成**可缓存的纯函数**：输入是 `{命令行, 读的那几份文件, 装进去的那些模块}`，
// 输出是 `{code, out, err}`。三样都没变就直接把上次的输出交出去。
//
// 依赖**不是猜的**：子进程带一格 `--import` 钩子（deps-hook.mjs），它把真正 `load` 过的模块
// 路径写成一份清单。所以：
//   - 改 `frontend-jnc/lower.js` 只让装过它的那些用例失效（jnc / glr 那些），别的轴一格不动；
//   - 只加一份固件时，别的用例全命中 —— 那正是"改一处、跑一轴"最常见的形状。
//
// 键里刻意**不含时间、不含随机**：同一份输入两次跑出来的键一样。反过来说，靠时间/随机/环境
// 变化的用例不能进这一层（它们本来也不该在"逐字节相同"的轴上）。
//
// 开关：`FORCE=1` 全部重跑（缓存照旧更新）、`NOCACHE=1` 完全不读不写。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const HOOK = join(HERE, 'deps-hook.mjs');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** 一份文件的内容哈希（一趟里只读一次 —— 一条轴上同一份源文件会被问几百遍）。 */
const fileHashes = new Map();
export function fileHash(p) {
  const had = fileHashes.get(p);
  if (had !== undefined) return had;
  let h = 'x';
  try {
    h = statSync(p).isDirectory() ? dirHash(p) : sha(readFileSync(p));
  } catch { /* 不在就是 'x'：不在也是一种输入 */ }
  fileHashes.set(p, h);
  return h;
}

/** 一个目录的内容哈希（一层，按名字排序 —— `imports/` `incdirs/` 那种小目录用）。 */
function dirHash(d) {
  const names = readdirSync(d).sort();
  return sha(names.map((n) => `${n}:${fileHash(join(d, n))}`).join('\n'));
}

/**
 * 一条轴的运行缓存。
 *
 * 键分两段，为的是解开"要先知道依赖才能查、可依赖是跑完才知道"这个环：
 *   - **查得到的那一段**：命令行 + 实参里那几份文件（存在的才算）。这一段跑之前就有。
 *   - **对得上的那一段**：上一趟记下来的模块清单，现在重新哈希一遍。对得上才算命中。
 *
 * 所以一条记录长这样：`{ deps: [路径…], depsHash, code, out, err }`。
 */
export class RunCache {
  constructor(axis) {
    this.axis = axis;
    this.force = process.env.FORCE === '1';
    this.off = process.env.NOCACHE === '1';
    const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
    this.dir = join(base, 'test', 'verdict');
    this.path = join(this.dir, `${axis}.json`);
    this.tmp = join(this.dir, `${axis}-deps`);
    this.db = new Map();
    if (!this.off && existsSync(this.path)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.path, 'utf8')))) {
          this.db.set(k, v);
        }
      } catch { /* 坏了就当没有 */ }
    }
    this.hit = 0;
    this.miss = 0;
    this.dirty = false;
    /* 这一趟**自己写进去**的那些键：`FORCE=1` 只该越过「上一趟留下的」，不该把预热刚跑出来的
       那一份也当作不存在 —— 否则每个子进程要跑两遍（踩过，量出来正好两倍慢）。 */
    this.fresh = new Set();
  }

  /** 命令行里那些"是文件/目录"的实参 —— 它们的内容也是输入。 */
  static inputsOf(args, extra) {
    const out = [];
    for (const a of [...args, ...extra]) {
      if (typeof a !== 'string' || a.startsWith('-')) continue;
      if (existsSync(a)) out.push(a);
    }
    return out.sort();
  }

  /**
   * 跑一次（或者把上一次的结果交出来）。
   *
   * @param {string[]} args node 的实参（第一个通常是那份 cli.js）
   * @param {{cwd?: string, extra?: string[], env?: object}} o
   *        `extra` 是"命令行里看不见但也算输入"的路径（比如用例旁边的 `imports/` 目录）
   * @returns {{code: number, out: string, err: string, cached: boolean}}
   */
  run(args, o = {}) {
    const cwd = o.cwd ?? ROOT;
    const inputs = RunCache.inputsOf(args, o.extra ?? []);
    const key = sha(JSON.stringify([args, cwd, o.env ?? null,
      inputs.map((p) => `${p}:${fileHash(p)}`)]));
    const had = this.db.get(key);
    if (had !== undefined && !this.off && (!this.force || this.fresh.has(key))) {
      // 记下来的那份模块清单现在还是不是同一份内容 —— 对得上才算命中
      if (hashList(had.deps) === had.depsHash) {
        this.hit++;
        return { code: had.code, out: had.out, err: had.err, cached: true };
      }
    }
    this.miss++;
    const r = this.spawn(args, cwd, o.env);
    if (!this.off) {
      this.db.set(key, { deps: r.deps, depsHash: hashList(r.deps), code: r.code, out: r.out, err: r.err });
      this.fresh.add(key);
      this.dirty = true;
    }
    return { code: r.code, out: r.out, err: r.err, cached: false };
  }

  /** 真跑一次（同步），顺手把"装载过哪些模块"收回来。 */
  spawn(args, cwd, env) {
    const list = this.depsFile();
    const r = spawnSync(process.execPath, ['--import', HOOK, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...(env ?? {}), OMNI_DEPS_OUT: list },
    });
    return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '', deps: this.readDeps(list) };
  }

  /**
   * 真跑一次（异步）。预热那一格用它 —— **`spawnSync` 会把整条事件循环堵住**，几条 worker
   * 于是一条接一条地跑，量出来不但没快，还因为多跑一遍变成两倍慢（这一格踩过）。
   */
  spawnAsync(args, cwd, env) {
    const list = this.depsFile();
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--import', HOOK, ...args], {
        cwd,
        env: { ...process.env, ...(env ?? {}), OMNI_DEPS_OUT: list },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.setEncoding('utf8');
      p.stderr.setEncoding('utf8');
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { err += c; });
      p.on('close', (code) => {
        resolve({ code: code === null ? 1 : code, out, err, deps: this.readDeps(list) });
      });
    });
  }

  /** 这一次的依赖清单落哪儿（每次一份，跑完就删）。 */
  depsFile() {
    mkdirSync(this.dir, { recursive: true });
    this.seq = (this.seq ?? 0) + 1;
    const p = `${this.tmp}-${process.pid}-${this.seq}.txt`;
    rmSync(p, { force: true });
    return p;
  }

  /** 把清单读回来。收不到就塞一格"永远对不上"的记号 —— 那一格下一趟必须重跑。 */
  readDeps(list) {
    let deps = [];
    try {
      deps = [...new Set(readFileSync(list, 'utf8').split('\n').filter((x) => x !== ''))].sort();
    } catch { /* 钩子没写出来（进程一开始就死了） */ }
    rmSync(list, { force: true });
    return deps.length === 0 ? ['\u0000none'] : deps;
  }

  /**
   * 预热：把**这一趟要跑的那些命令**里没命中的那些**并行**跑掉（ADR-0023 的 S4）。
   *
   * 为什么要单开一格而不是把整条轴改成并行：轴自己的判定逻辑是顺序的（一条用例先跑第一条腿、
   * 再拿别的腿去比），改成并行要动每一条轴的骨架。而"贵的是子进程"—— 所以只把子进程这一步
   * 提前、并行做掉，顺序那一遍照旧走，只是每一次都命中。
   *
   * 并行度 `JOBS`（默认 `min(4, 核数-2)`）：刻意不敢开满 —— 编出来的产物要落盘，几条腿共用
   * 同一个缓存根（`.omni-cache`），并行度越高越容易撞。撞了就是假红，宁可慢一点。
   */
  async warm(argLists, o = {}) {
    if (this.off) return;
    const cwd = o.cwd ?? ROOT;
    const todo = [];
    for (const args of argLists) {
      const inputs = RunCache.inputsOf(args, o.extra ?? []);
      const key = sha(JSON.stringify([args, cwd, o.env ?? null,
        inputs.map((p) => `${p}:${fileHash(p)}`)]));
      const had = this.db.get(key);
      if (!this.force && had !== undefined && hashList(had.deps) === had.depsHash) continue;
      todo.push({ args, key });
    }
    if (todo.length === 0) return;
    const jobs = Math.max(1, Number(process.env.JOBS || 0)
      || Math.min(4, (os.availableParallelism?.() ?? 4) - 2));
    let at = 0;
    const worker = async () => {
      for (;;) {
        const i = at;
        at += 1;
        if (i >= todo.length) return;
        const t = todo[i];
        // eslint-disable-next-line no-await-in-loop -- worker 自己就是一条队列，串行是故意的
        const r = await this.spawnAsync(t.args, cwd, o.env);
        this.db.set(t.key, {
          deps: r.deps, depsHash: hashList(r.deps), code: r.code, out: r.out, err: r.err,
        });
        this.fresh.add(t.key);
        this.dirty = true;
        this.warmed = (this.warmed ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: jobs }, () => worker()));
  }

  /** 落盘（跑完叫一次）。顺手印一行命中率 —— 那是这一层唯一要看的数。 */
  report(write = true) {
    if (write && this.dirty && !this.off) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(Object.fromEntries(this.db))}\n`);
    }
    const n = this.hit + this.miss;
    return n === 0 ? '' : `子进程 ${n} 次：命中 ${this.hit}、真跑 ${this.miss}`;
  }
}

/** 一串路径的内容哈希（路径 + 内容都算 —— 少一份文件也是变了）。 */
function hashList(paths) {
  return sha(paths.map((p) => `${p}:${fileHash(p)}`).join('\n'));
}

/* ---------------------------------------------------------------- 轴级那一层
 *
 * 一条轴的**指纹** = 轴目录（固件 + 那份 run.js）的内容 + 这条轴依赖集里每份模块的内容。
 * 与"上一趟绿"的指纹一样就整轴跳过（见 ADR-0023 的 S2）。红的轴不入册 —— 下一趟照旧重跑。
 */

/** 一棵目录树的内容哈希（递归，按路径排序）。 */
export function hashTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try {
      names = readdirSync(d).sort();
    } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
      else out.push(`${rel}${n}:${fileHash(p)}`);
    }
  };
  walk(dir, '');
  return sha(out.join('\n'));
}

/** 这条轴上一趟装载过的模块（并起来）。没有缓存记录时回 null —— 那时只能按整棵 src 算。 */
export function axisDeps(axis) {
  const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
  const p = join(base, 'test', 'verdict', `${axis}.json`);
  if (!existsSync(p)) return null;
  try {
    const db = JSON.parse(readFileSync(p, 'utf8'));
    const set = new Set();
    for (const v of Object.values(db)) for (const d of v.deps ?? []) set.add(d);
    return set.size === 0 ? null : [...set].sort();
  } catch {
    return null;
  }
}

/**
 * 一条轴的指纹。`deps` 有记录就按它算（精确）；没有就退回"整棵 src + 整棵 tests/<轴>"——
 * 那时只要源码动一个字节这条轴就重跑，是**保守但不会说谎**的一头。
 */
export function axisFingerprint(axis, axisDir) {
  const deps = axisDeps(axis);
  const dep = deps === null ? hashTree(join(ROOT, 'src')) : hashList(deps);
  return sha(`${hashTree(axisDir)}|${dep}|${deps === null ? 'src' : 'deps'}`);
}

/** 轴级状态（`{指纹, 上一趟的退出码}`）。只有绿的那一趟才写进去。 */
export function axisState() {
  const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
  const p = join(base, 'test', 'state.json');
  const load = () => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    get: (axis) => load()[axis] ?? null,
    put: (axis, v) => {
      const db = load();
      db[axis] = v;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify(db, null, 1)}\n`);
    },
  };
}

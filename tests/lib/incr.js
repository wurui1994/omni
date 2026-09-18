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

import { CORE_DATA, PLUGIN_SET } from '../../src/core/plugin-set.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const HOOK = join(HERE, 'deps-hook.mjs');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** 超时那一格的消息。轴自己印的那句原本长这样，保持一字不差好让固件不必改。 */
const timeoutText = (ms) => `超时（${(ms ?? 0) / 1000}s 没跑完）`;


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

/* ------------------------------------------------------------ 数据文件那一格
 *
 * 依赖钩子只看得见 **`import` 进去的模块**。而编译器还读一批**数据**：语法表
 * （`asy.grammar` / `jnc.grammar`）、内建绑定表（`builtins.tab`）、库源码（`lib/`、
 * `lib/asy/`）、运行时 C（`runtime/`）、JIT 宿主（`jit/`）。改它们等于改编译器的行为，
 * 但 `load` 钩子一格都收不到 —— 缓存于是会拿旧输出骗人（ADR-0023 记的那个洞）。
 *
 * 哪些文件算数据**不用另立一张表**：`src/core/plugin-set.js` 里每格插件的 `data` 与
 * `CORE_DATA` 就是那张表（它本来的用途是 `omni plugins` 往 dist/share 抄哪些东西）。
 * 这里把它们**整份**哈希一次，混进每一个键 —— 保守（改 `runtime/omni.h` 会让所有轴失效，
 * 而那是对的：每条 C 腿都读它），但不会说谎。整趟只算一次，量出来 4ms。
 */
const DATA_RELS = [
  ...PLUGIN_SET.flatMap((p) => p.data.map((rel) => ({ rel, probe: null }))),
  ...CORE_DATA.map((c) => ({ rel: `${c.dir}/`, probe: c.probe })),
];

let dataFp = null;
function dataFingerprint() {
  if (dataFp !== null) return dataFp;
  const parts = [];
  for (const { rel, probe } of [...DATA_RELS].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const isDir = rel.endsWith('/');
    const clean = isDir ? rel.slice(0, -1) : rel;
    let h = 'x';
    /* 与 host/data.js 的 dataRoots 同序（src/core 先、src 后）。`probe` 是同名目录的
       消歧标志 —— `runtime` 在源码树里有两个（src/runtime 是 C、src/core/runtime 是 JS）。 */
    for (const r of [join(ROOT, 'src', 'core'), join(ROOT, 'src')]) {
      const p = join(r, clean);
      if (!existsSync(p)) continue;
      if (probe !== null && !existsSync(join(p, probe))) continue;
      h = isDir ? hashTree(p) : fileHash(p);
      break;
    }
    parts.push(`${rel}:${h}`);
  }
  dataFp = sha(parts.join('\n'));
  return dataFp;
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
  constructor(axis, o = {}) {
    this.axis = axis;
    this.force = process.env.FORCE === '1';
    /* `record: true` = **只记依赖、不缓存**。给那些"产物是磁盘上的文件"或者判据本身要求
       每次真跑的轴用（ADR-0023 §6）：它们照旧一次不少地跑，但会把"这一趟到底装了哪些模块"
       记下来 —— 轴级指纹要的就是这一份。不记的话指纹只能退回整棵 src，于是改任何一门语言
       的前端都会让它重跑（量出来过：改一行 lower.js，wat / cabi 照旧全跑）。 */
    this.record = o.record === true;
    this.off = process.env.NOCACHE === '1' || this.record;
    const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
    this.dir = join(base, 'test', 'verdict');
    this.path = join(this.dir, `${axis}.json`);
    this.depsPath = join(this.dir, `${axis}.deps.json`);
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
    /* **这一趟真用到的那些依赖**（命中的与真跑的都算）。轴级指纹要的就是这一份 ——
       不是"这份缓存文件里历史上出现过的所有依赖"：那一份只会越攒越胖，而且迟装
       （ADR-0023 S7）之前留下的老记录里含着每一门语言的前端，于是"改 jnc 前端"照旧会让
       每条轴的指纹变掉。量出来过：改一行 lower.js，sexpr / wat / cabi 三条轴仍旧重跑。 */
    this.touched = new Set();
    /* 真跑掉的那些的耗时（预热并行那一遍也记）：一条轴慢下来的时候要能立刻说出
       "哪几条命令最贵"，而不是只知道"这条轴 60s"。 */
    this.spent = 0;
    this.runs = [];

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

  /** 一次调用的**查得到的那一段**键：命令行 + 环境 + 实参里那几份文件 + 那批数据文件。 */
  static keyOf(args, cwd, o) {
    const inputs = RunCache.inputsOf(args, o.extra ?? []);
    return sha(JSON.stringify([args, cwd, o.env ?? null, o.input ?? null,
      inputs.map((p) => `${p}:${fileHash(p)}`), dataFingerprint()]));
  }

  /**
   * 跑一次（或者把上一次的结果交出来）。
   *
   * @param {string[]} args node 的实参（第一个通常是那份 cli.js）
   * @param {{cwd?: string, extra?: string[], env?: object, timeout?: number}} o
   *        `extra` 是"命令行里看不见但也算输入"的路径（比如用例旁边的 `imports/` 目录）；
   *        `timeout` 是这一次的上限（毫秒）—— **超时的那一次不入册**，见下。
   * @returns {{code: number, out: string, err: string, cached: boolean}}
   */
  run(args, o = {}) {
    const cwd = o.cwd ?? ROOT;
    const key = RunCache.keyOf(args, cwd, o);
    const had = this.db.get(key);
    if (had !== undefined && !this.off && (!this.force || this.fresh.has(key))) {
      // 记下来的那份模块清单现在还是不是同一份内容 —— 对得上才算命中
      if (hashList(had.deps) === had.depsHash) {
        this.hit++;
        for (const d of had.deps) this.touched.add(d);
        return {
          code: had.code, out: had.out, err: had.err, status: had.status ?? null, cached: true, ms: 0,
        };
      }
    }
    this.miss++;
    const t0 = Date.now();
    const r = this.spawn(args, cwd, o.env, o.timeout, o.input);
    const ms = Date.now() - t0;
    this.spent = (this.spent ?? 0) + ms;
    this.runs.push({ args, ms });
    for (const d of r.deps) this.touched.add(d);
    /* **超时不入册**：那不是这份输入的"结果"，是这台机器这一刻的状态（别的轴在并行、
       机器在换页）。记下来就会把一次偶然的卡顿钉成永久的红。
       **非零退出码不入册**（task #55）：失败可能是暂态的（并行竞态、磁盘满、OOM），
       如果记下来就会**粘在缓存里**——之后每次跑都从缓存拿那个失败（"命中 147、真跑 0"
       却报两格红），NOCACHE=1 只是不读不写治不了，得 FORCE=1 才刷。
       一格假红粘在缓存里比一格真红更坏（真红你会去看，假红你会开始不信判据）。 */
    if (!this.off && r.timedOut !== true && r.code === 0) {
      this.db.set(key, {
        deps: r.deps,
        depsHash: hashList(r.deps),
        code: r.code,
        out: r.out,
        err: r.err,
        status: r.status,
      });
      this.fresh.add(key);
      this.dirty = true;
    }
    return {
      code: r.code, out: r.out, err: r.err, status: r.status, cached: false, ms,
    };
  }

  /** 真跑一次（同步），顺手把"装载过哪些模块"收回来。 */
  spawn(args, cwd, env, timeout, input) {
    const list = this.depsFile();
    const opts = {
      encoding: 'utf8',
      cwd,
      /* 64 MB：这一层要能收下最大的那些输出（tests/oir 与 tests/oracle 本来就把 maxBuffer
         开到这个数 —— 默认 1 MB 会把大输出截断，而截断表现成"输出不一样"，最难查）。 */
      maxBuffer: 1 << 26,
      env: { ...process.env, ...(env ?? {}), OMNI_DEPS_OUT: list },
    };
    if (input !== undefined) opts.input = input;
    if (timeout !== undefined) {
      opts.timeout = timeout;
      opts.killSignal = 'SIGKILL';
    }
    const r = spawnSync(process.execPath, ['--import', HOOK, ...args], opts);
    const deps = this.readDeps(list);
    if (r.error !== undefined && r.error !== null && r.error.code === 'ETIMEDOUT') {
      return {
        code: 124, status: 124, out: r.stdout ?? '', err: timeoutText(timeout), deps, timedOut: true,
      };
    }
    /* `status` 是**原样**的退出码（信号打死时是 null）。`code` 是归一过的那份（null -> 1）。
       两个都留着：多数轴只看 `code !== 0`，而 tests/c 那条轴拿退出码本身当 oracle 的一部分
       （tcc 与我们要同一个数），把"被信号打死"混成 1 会让那条比对变虚。 */
    return {
      code: r.status ?? 1,
      status: r.status === undefined ? null : r.status,
      out: r.stdout ?? '',
      err: r.stderr ?? '',
      deps,
    };
  }

  /**
   * 真跑一次（异步）。预热那一格用它 —— **`spawnSync` 会把整条事件循环堵住**，几条 worker
   * 于是一条接一条地跑，量出来不但没快，还因为多跑一遍变成两倍慢（这一格踩过）。
   */
  spawnAsync(args, cwd, env, timeout) {
    const list = this.depsFile();
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--import', HOOK, ...args], {
        cwd,
        env: { ...process.env, ...(env ?? {}), OMNI_DEPS_OUT: list },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let killed = false;
      const timer = timeout === undefined ? null : setTimeout(() => {
        killed = true;
        p.kill('SIGKILL');
      }, timeout);
      p.stdout.setEncoding('utf8');
      p.stderr.setEncoding('utf8');
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { err += c; });
      p.on('close', (code) => {
        if (timer !== null) clearTimeout(timer);
        const deps = this.readDeps(list);
        if (killed) {
          resolve({
            code: 124, status: 124, out, err: timeoutText(timeout), deps, timedOut: true,
          });
          return;
        }
        resolve({
          code: code === null ? 1 : code, status: code, out, err, deps,
        });
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
      const key = RunCache.keyOf(args, cwd, o);
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
        const tw = Date.now();
        const r = await this.spawnAsync(t.args, cwd, o.env, o.timeout);
        this.runs.push({ args: t.args, ms: Date.now() - tw });
        this.warmed = (this.warmed ?? 0) + 1;
        if (r.timedOut === true) continue; // 超时不入册（理由同 run()）
        for (const d of r.deps) this.touched.add(d);
        this.db.set(t.key, {
          deps: r.deps,
          depsHash: hashList(r.deps),
          code: r.code,
          out: r.out,
          err: r.err,
          status: r.status,
        });
        this.fresh.add(t.key);
        this.dirty = true;
      }
    };
    await Promise.all(Array.from({ length: jobs }, () => worker()));
  }

  /**
   * 最贵的那几条命令（一行一条）。慢下来的时候先看这张榜 —— 它直接说出钱花在哪几个
   * 子进程上；命中的那些不在榜上（它们不花钱）。名字掐成"命令 + 最后那个路径"，
   * 因为完整命令行里前面那一大截 `node …/cli.js` 每条都一样、没有信息量。
   */
  slowest(n = 8, minMs = 200) {
    const top = [...this.runs].sort((a, b) => b.ms - a.ms).slice(0, n)
      .filter((x) => x.ms >= minMs);
    if (top.length === 0) return '';
    const brief = (args) => {
      const rest = args.slice(1).filter((a) => !a.endsWith('cli.js'));
      const last = rest.length === 0 ? '' : rest[rest.length - 1];
      const tail = last.includes('/') ? last.slice(last.lastIndexOf('/') + 1) : last;
      return `${rest.slice(0, -1).join(' ')} ${tail}`.trim();
    };
    return top.map((x) => `${brief(x.args)} ${(x.ms / 1000).toFixed(2)}s`).join('、');
  }

  /**
   * 按**命令**（第一格动词）把真跑掉的时间加起来：`run 3.2s、run-c 12.1s、run-llvm 9.8s…`。
   * 这是"要不要少跑几条腿"这个决定唯一的依据 —— 不看这张表就只能拍脑袋。
   */
  byCmd() {
    const sum = new Map();
    for (const r of this.runs) {
      const verb = r.args.find((a) => !a.endsWith('cli.js') && !a.startsWith('-')) ?? '?';
      sum.set(verb, (sum.get(verb) ?? 0) + r.ms);
    }
    const rows = [...sum.entries()].sort((a, b) => b[1] - a[1]);
    return rows.map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join('、');
  }

  /** 落盘（跑完叫一次）。顺手印一行命中率 —— 那是这一层唯一要看的数。 */


  report(write = true) {
    if (write) {
      mkdirSync(this.dir, { recursive: true });
      if (this.dirty && !this.off) {
        writeFileSync(this.path, `${JSON.stringify(Object.fromEntries(this.db))}\n`);
      }
      /* **这一趟真用到的依赖**单独落一份：轴级指纹按它算（见 axisDeps）。
         与 verdict 那份分开是有意的 —— verdict 是"输入 -> 输出"的账，这一份是"这条轴现在
         到底装了哪些模块"，后者会随迟装而变瘦，前者不该被它带着重写。 */
      if (this.touched.size > 0 && process.env.NOCACHE !== '1') {
        writeFileSync(this.depsPath, `${JSON.stringify([...this.touched].sort(), null, 1)}\n`);
      }
    }
    const n = this.hit + this.miss;
    if (n === 0) return '';
    /* 真跑掉的秒数也印出来 —— "命中率 100%" 不等于"不慢"：一条轴慢下来的时候要一眼看出
       钱花在"子进程"还是"轴自己那点在进程内的活"上。预热并行跑掉的那些不算在这里
       （它们的墙上时间在预热那一行）。 */
    const sec = ((this.spent ?? 0) / 1000).toFixed(1);
    return `子进程 ${n} 次：命中 ${this.hit}、真跑 ${this.miss}`
      + `${this.miss > 0 ? `（顺序那一遍真跑 ${sec}s）` : ''}`;
  }
}

/** 一串路径的内容哈希（路径 + 内容都算 —— 少一份文件也是变了）。 */
function hashList(paths) {
  return sha(paths.map((p) => `${p}:${fileHash(p)}`).join('\n'));
}

/**
 * 给"什么都 spawn"的那些轴用的一格包装（ADR-0023 的 S7）。
 *
 * 那些轴的 `run(cmd, args)` 什么都收：`node`、`clang`、`qjs`、刚编出来的可执行文件。
 * 这一格按 `cmd` 分岔 —— 是 node 就走 RunCache（于是**这一趟装了哪些模块**记得下来，
 * 轴级指纹才能精确到"改 jnc 前端不动 wat"）；别的照旧原样跑：外部工具没有模块图可记，
 * 记不出东西来，硬塞进缓存只会假装精确。
 *
 * 默认 `record: true`（只记依赖、不缓存）：这些轴里落文件的步骤太多，缓存要一条条量过
 * 才敢开（§6 那条规矩）。要给某条轴开缓存就显式传 `{}`。
 */
export function mixedRunner(axis, o = { record: true }) {
  const cache = new RunCache(axis, o);
  const run = (cmd, args, opts = {}) => {
    if (cmd === process.execPath || cmd === 'node') {
      const r = cache.run(args, opts);
      return {
        out: r.out, err: r.err, code: r.code, status: r.status,
      };
    }
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return {
      out: r.stdout ?? '',
      err: r.stderr ?? '',
      code: r.status ?? 1,
      status: r.status === undefined ? null : r.status,
    };
  };
  return { cache, run };
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

/**
 * 这条轴**上一趟真装过**的那些模块。出处按顺序两处：
 *   1. `<轴>.deps.json` —— 上一趟用到的那一份（精确，RunCache.report 写的）；
 *   2. 退回 verdict 里所有记录的并集 —— 那是**历史**的并集，只会越攒越胖（迟装之前留下的
 *      老记录里含着每一门语言的前端），所以只在还没有 1 的时候用。
 * 两处都没有就回 null —— 那时只能按整棵 src 算。
 */
export function axisDeps(axis) {
  const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
  const dir = join(base, 'test', 'verdict');
  const fresh = join(dir, `${axis}.deps.json`);
  if (existsSync(fresh)) {
    try {
      const list = JSON.parse(readFileSync(fresh, 'utf8'));
      if (Array.isArray(list) && list.length > 0) return [...list].sort();
    } catch { /* 坏了就当没有 */ }
  }
  const p = join(dir, `${axis}.json`);
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
 * 两头都再混一格**数据文件**的指纹：语法表那些不是模块，钩子看不见（见 dataFingerprint）。
 */
export function axisFingerprint(axis, axisDir) {
  const deps = axisDeps(axis);
  const dep = deps === null ? hashTree(join(ROOT, 'src')) : hashList(deps);
  return sha(`${hashTree(axisDir)}|${dep}|${dataFingerprint()}|${deps === null ? 'src' : 'deps'}`);
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

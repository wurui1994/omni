/**
 * **热工人池**（`omni serve` 的执行面）。
 *
 * 一句话：把"每请求一个子进程"换成"几格常驻工人排队干活"。账在 `worker.js` 的头注里 ——
 * 一趟 180ms 里有 110ms 是 node 启动 + 装编译器，而那与这份源码半点关系都没有。
 * 热起来之后同一门语言第二趟 **2~11ms**。
 *
 * ## 形状
 *
 * * **N 格工人**（默认 `min(4, 核数-1)`，`OMNI_STUDIO_WORKERS` 可改）。一格工人一次
 *   只干一件事 —— `cli.js` 的模块级全局并发重入会串味，那条限制没变，只是从"每请求
 *   一个进程"变成"每工人一条队"。
 * * **懒起**：第一格请求来了才 fork，之后一直热着。起不来就退回冷子进程，服务不因此红。
 * * **跑够 K 次就换**（默认 64）：模块级全局跨请求攒的那点脏，换一个新工人比证明它干净便宜。
 * * **时限由池子数**：到点直接杀掉那个工人（CLI 自己那格开发期时限在工人里是关掉的 ——
 *   它到点会给整个进程一枪，而那是常驻的）。
 * * **只接热得住的动词**（`run` / `emit`）。`build` 要 spawn cc、`c link` 要写盘，
 *   那几格照旧走冷子进程 —— 池子的波及面越小越好。
 *
 * ## 为什么不是 worker_threads
 *
 * 因为要**逐字节地捕获两股输出**。线程里的 `process.stdout` 是转发到父进程的管子，
 * 换掉它只换得到这一格线程的那一份；而子进程里把 `process.stdout.write` 换成收集器
 * 之后，fd 1 上只剩协议帧 —— 干净，而且"崩了只崩一个工人"顺手就有了。
 */

import { join } from '../host/path.js';

const nodeMod = (name) => process.getBuiltinModule(name);

/** 这几格动词热得住（在进程内跑安全且有意义）。 */
const WARM_VERBS = new Set(['run', 'emit', 'ast', 'oir', 'sx', 'graph', 'interp']);

/** 一格工人跑多少趟就换掉。 */
const RECYCLE_AFTER = 64;

/** 这一条命令该走热工人吗？ */
export function warmable(argv) {
  return Array.isArray(argv) && argv.length > 0 && WARM_VERBS.has(argv[0]);
}

class Worker {
  constructor(root) {
    const cp = nodeMod('node:child_process');
    this.root = root;
    this.served = 0;
    this.busy = false;
    this.dead = false;
    this.ready = false;
    this.buf = '';
    /** 等着回音的那一格（`{resolve, reject, timer}`）—— 一次只有一格。 */
    this.pending = null;
    this.proc = cp.spawn(process.execPath, [join(root, 'src', 'core', 'studio', 'worker.js')], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      /* `OMNI_CLI_NO_SHOT=1` 只关掉"到点给本进程一枪"那一格（本进程是常驻工人）——
         **预算留着**。从前这儿给的是 `OMNI_TIMEOUT=0` / `OMNI_BUILD_TIMEOUT=0`，
         而那两格会跟着孩子走：`spawnSync` 没了时限、生成出来的程序里那格 SIGALRM
         与外部看门狗也一起关掉。量出来的后果（2026-09-26）：一个 GUI 例子跑了
         28 分钟还在，父进程早就没了（孤儿）。见 worker.js 的第 3 条纪律。 */
      env: { ...process.env, OMNI_AS_LIB: '1', OMNI_CLI_NO_SHOT: '1' },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.onData(c));
    /* 工人自己的 stderr（协议之外的东西：node 的告警、装不起来时的栈）——留着当诊断，
       别丢：丢了之后"工人起不来"表现成"请求一直不回"。 */
    this.stderrBuf = '';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => { this.stderrBuf = (this.stderrBuf + c).slice(-4000); });
    this.proc.on('exit', () => this.onExit());
    this.proc.on('error', () => this.onExit());
    /** 起来那一刻（`{ready:true}` 那一帧）。 */
    this.booted = new Promise((ok, bad) => { this.bootOk = ok; this.bootBad = bad; });
  }

  onData(chunk) {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim().length === 0) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready === true) { this.ready = true; this.bootOk(this); continue; }
      const p = this.pending;
      if (p === null) continue;
      this.pending = null;
      this.busy = false;
      this.served = msg.served ?? (this.served + 1);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  onExit() {
    this.dead = true;
    if (!this.ready) this.bootBad(new Error(`工人起不来：${this.stderrBuf.slice(-500)}`));
    const p = this.pending;
    if (p !== null) {
      this.pending = null;
      this.busy = false;
      clearTimeout(p.timer);
      p.resolve({
        stdout: '',
        stderr: `omni: 这一趟把工人跑挂了（或者超了时限）。${this.stderrBuf.slice(-500)}\n`,
        code: 124,
      });
    }
  }

  /** 递一趟活。`timeoutS <= 0` = 不限（那时只有工人自己挂了才回）。 */
  send(argv, timeoutS) {
    this.busy = true;
    return new Promise((resolve) => {
      const timer = timeoutS > 0 ? setTimeout(() => {
        /* 到点：杀掉这个工人（在进程内跑的那一趟没法中断 —— 单线程，死循环里
           连事件循环都不转）。池子下一趟会起一格新的。 */
        this.dead = true;
        try { this.proc.kill('SIGKILL'); } catch { /* 已经走了 */ }
      }, timeoutS * 1000) : null;
      this.pending = { resolve, timer };
      try {
        this.proc.stdin.write(`${JSON.stringify({ id: this.served + 1, argv })}\n`);
      } catch (e) {
        this.pending = null;
        this.busy = false;
        if (timer !== null) clearTimeout(timer);
        this.dead = true;
        resolve({ stdout: '', stderr: `omni: 递不进工人（${e.message}）\n`, code: 1 });
      }
    });
  }

  stop() {
    this.dead = true;
    try { this.proc.kill('SIGTERM'); } catch { /* 已经走了 */ }
  }
}

/**
 * 池子。`run(argv, timeoutS)` 回 `{stdout, stderr, code, ms}`；
 * 热不住的动词或者池子起不来时回 `null` —— 调用方那时走冷子进程。
 */
export class Pool {
  constructor(root, size) {
    const os = nodeMod('node:os');
    const want = size ?? Number(process.env.OMNI_STUDIO_WORKERS ?? 0);
    this.root = root;
    this.size = want > 0 ? want : Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
    this.workers = [];
    /** 排着队的那几格（`{argv, timeoutS, resolve}`）。 */
    this.queue = [];
    this.off = false;
  }

  /** 现在有几格工人、几格在干活（`/api/health` 印它）。 */
  stat() {
    return {
      size: this.size,
      alive: this.workers.filter((w) => !w.dead).length,
      busy: this.workers.filter((w) => w.busy && !w.dead).length,
      queued: this.queue.length,
      served: this.workers.reduce((a, w) => a + w.served, 0),
    };
  }

  /** 取一格能干活的工人（不够就补，满了回 null）。 */
  pick() {
    this.workers = this.workers.filter((w) => !w.dead && w.served < RECYCLE_AFTER);
    const idle = this.workers.find((w) => !w.busy && w.ready);
    if (idle !== undefined) return idle;
    if (this.workers.length < this.size) {
      const w = new Worker(this.root);
      this.workers.push(w);
      return w;
    }
    return null;
  }

  async run(argv, timeoutS) {
    if (this.off || !warmable(argv)) return null;
    const w = this.pick();
    if (w === null) {
      /* 全忙着：排队。前一趟一回来就有人叫醒这一格。 */
      return new Promise((resolve) => { this.queue.push({ argv, timeoutS, resolve }); });
    }
    try {
      if (!w.ready) await w.booted;
    } catch {
      /* 工人起不来（少见：改坏了 worker.js / node 装不起来）—— 整池关掉，
         调用方退回冷子进程。响一声，别静默变慢。 */
      this.off = true;
      process.stderr.write('omni serve: 热工人起不来，退回"每请求一个子进程"\n');
      return null;
    }
    const r = await w.send(argv, timeoutS);
    this.drain();
    return r;
  }

  /** 有工人闲下来了：叫队里第一格。 */
  drain() {
    if (this.queue.length === 0) return;
    const w = this.pick();
    if (w === null) return;
    const job = this.queue.shift();
    (async () => {
      try { if (!w.ready) await w.booted; } catch { job.resolve(null); return; }
      job.resolve(await w.send(job.argv, job.timeoutS));
      this.drain();
    })();
  }

  /** 预热：现在就起一格工人。`omni serve` 起来的时候叫它，于是**第一格请求也是热的**。 */
  async warm() {
    if (this.off) return;
    const w = this.pick();
    if (w === null) return;
    try { await w.booted; } catch { this.off = true; }
  }

  stop() {
    this.off = true;
    for (const w of this.workers) w.stop();
    this.workers = [];
    for (const j of this.queue) j.resolve(null);
    this.queue = [];
  }
}

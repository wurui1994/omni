#!/usr/bin/env node
/**
 * **热工人**：一格常驻进程，一趟接一趟地在**进程内**跑 omni 命令。
 *
 * 为什么要它（量出来的，不是猜的）：
 *
 *   一趟 `omni run x.go`（磁盘缓存全热）总共 **180ms**，其中
 *     * **110ms** 是"宿主 + 装编译器"（node 启动 + import 两百多份 ESM）
 *     * 15ms 是读语法表（`glr/load.js` 的磁盘缓存那一层）
 *     * 剩下 ~50ms 才是真编译 + 真跑
 *
 *   也就是说"每请求一个子进程"那一刀，**七成的时间花在与这份源码无关的事上**。
 *   而 Studio 的实时模式是 250ms 防抖 —— 那点预算全被启动吃掉了，用户感觉不到"实时"。
 *
 *   热起来之后（同一门语言第二趟）：go **2ms**、nim 11ms、chez 6ms。**快一个数量级。**
 *
 * ## 协议（NDJSON，一行一格）
 *
 *   stdin  <- `{"id":N,"argv":["run","x.go","-v"]}`
 *   fd 1   -> `{"id":N,"stdout":"…","stderr":"…","code":0,"ms":12}`
 *
 * **响应走 `writeSync(1, …)`，不走 `process.stdout.write`** —— 后者已经被换成收集器了
 * （编译器与被跑的程序的输出都落在那儿）。于是 fd 1 上只有协议帧，一个字节都不掺。
 *
 * ## 三条纪律
 *
 *   1. **一次只做一件事**。`cli.js` 有一堆模块级全局（`VERBOSE` / `SRC_SX` / `IMPORTS`
 *      那一族），并发重入会互相串味。池子那侧保证一个工人同时只有一格请求。
 *   2. **跑够 K 次就让池子换掉我**（`done` 里报次数）。模块级全局跨请求攒下来的那点脏
 *      没人能证明是干净的 —— 换一个新的比证明便宜。
 *   3. **时限不由我管**。`OMNI_TIMEOUT=0` 关掉 CLI 自己那格开发期时限（它到点会给整个
 *      进程一枪，而那是池子的常驻工人）；超时由池子数着，到点直接杀。
 */

/* **当库用**：`core/cli.js` 见到这一格就不自己 `main(procArgs())`。要在 import 之前设。 */
process.env.OMNI_AS_LIB = '1';
process.env.OMNI_TIMEOUT = '0';
process.env.OMNI_BUILD_TIMEOUT = '0';
/* **有人在收着输出**（`host/native.js` 的 `CAPTURED`）：`spawn` 出去的孩子不许 `inherit`
   fd 1 —— 那一格在这儿是 NDJSON 协议的通道。漏进去的话池子只能把它当坏帧丢掉，
   表现成"跑成功了可是没有输出"（`.asy` 与别的会 spawn 的腿都撞过）。 */
process.env.OMNI_CAPTURE = '1';

const fs = await import('node:fs');

/* ---- 两股输出的收集器（整个生命周期都挂着）---- */
let OUT = [];
let ERR = [];
const asText = (s) => (typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
process.stdout.write = (s) => { OUT.push(asText(s)); return true; };
process.stderr.write = (s) => { ERR.push(asText(s)); return true; };

/* 装编译器（这一趟就是那 110ms —— 一格工人一辈子只付一次）。 */
const { runCli } = await import('../cli.js');

/** 一行协议帧（`writeSync` 直接走 fd 1，绕开上面那个收集器）。 */
function reply(obj) {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`);
}

let served = 0;

function handle(req) {
  OUT = [];
  ERR = [];
  const t0 = Date.now();
  let code = 0;
  try {
    code = runCli(req.argv);
  } catch (e) {
    /* `OmniError` 已经被 `runCli` 接住并印成一句话了；能到这儿的是**我们自己的 bug**
       （生成了坏代码、断言炸了）。照实说，别糊成"跑失败了"。 */
    ERR.push(`omni: internal error: ${e && e.stack ? e.stack : String(e)}\n`);
    code = 1;
  }
  served += 1;
  reply({
    id: req.id,
    stdout: OUT.join(''),
    stderr: ERR.join(''),
    code: typeof code === 'number' ? code : 1,
    ms: Date.now() - t0,
    served,
  });
  /* 上一趟留下的退出码别粘到下一趟（`setExitCode` 设的是进程的那一格）。 */
  process.exitCode = 0;
}

/* ---- 按行读 stdin ---- */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf('\n');
    if (i < 0) break;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim().length === 0) continue;
    let req = null;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
process.stdin.on('end', () => { process.exit(0); });

/* 起来了就报一声 —— 池子拿它当"这个工人可以收活了"。 */
reply({ ready: true });

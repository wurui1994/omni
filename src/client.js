#!/usr/bin/env node
/**
 * `omni --client …` 的 **node 侧入口**（`docs/design/omni-serve-studio.md` §3）。
 *
 * 一件事：把**同一条 argv** 发给 `omni serve`，回来的 stdout / stderr / 退出码原样落地。
 *
 * **判据只有一条**（也是这一格存在的全部意义）：同一条命令，本地跑与经服务跑，
 * stdout 逐字节相同、退出码相同。那一条把服务面钉死成"同一个编译器的另一个入口"，
 * 而不是第二份实现。
 *
 * 为什么另开一份文件（不让 `cli.js` 直接做）：`fetch` + `await` 那一族不该进
 * `check:self` 的静态模块图（与 `src/serve.js` 同一条理由，见那份的头注）。
 *
 * 用法（由 `cli.js` 那一格拼好）：`node src/client.js <服务地址> <argv…>`
 */

const [server, ...argv] = process.argv.slice(2);

if (server === undefined || argv.length === 0) {
  process.stderr.write('omni --client: 要一个服务地址与一条命令\n');
  process.exit(2);
}

/** 哪个端点。`emit` 那一格服务那侧的形状不同，别的一律 `/api/run`。 */
const endpoint = argv[0] === 'emit' ? '/api/emit' : '/api/run';

try {
  const r = await fetch(`${server.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    /* **整条 argv 原样递过去** —— 服务那侧不重新拼命令，所以两边走的是同一条路。 */
    body: JSON.stringify({ argv, timeout: Number(process.env.OMNI_TIMEOUT ?? 30) }),
  });
  if (!r.ok) {
    process.stderr.write(`omni --client: ${server} 回了 ${r.status}\n`);
    process.exit(1);
  }
  const j = await r.json();
  if (j.stdout) process.stdout.write(j.stdout);
  if (j.stderr) process.stderr.write(j.stderr);
  process.exit(j.code ?? 0);
} catch (e) {
  /* 连不上就说清楚**是连不上**，不是程序错了 —— 两种红看起来一样的时候最费时间。 */
  process.stderr.write(`omni --client: 连不上 ${server}（${e.message ?? e}）\n`
    + 'omni --client: 先起服务：omni serve\n');
  process.exit(1);
}

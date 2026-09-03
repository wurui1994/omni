// tests/bootstrap/ratchet.js —— 自编译那条链的**棘轮**（ADR-0001「量：自编译现在拦在哪儿」）
//
// 自编译现在是红的：JS 前端把 `src/core` 的 import 树链成一份程序时报错。那笔债什么时候还，
// 是另一件事；**这一门管的是它不许长大**。
//
// 为什么要有这一门：写那一节 ADR 的同一天我自己新造了一个重名（`cli/plan-c.js` 与
// `cli/plan-omni.js` 各一个 `opt`）。没有门的代价不是「有一笔旧债」，
// 而是**债会持续长出来** —— 只要那条链是红的，新的重名就没人当场拦。
//
// 四条断言：
//
//   1. 重名那一类**不许多**（基线 0，已清）
//   2. `import * as` 那一类**不许多**（基线 0，已清）
//   3. 缺 ABI op 那一类**不许多**（基线 8 处 / 5 个名字，这是现在真正的拦路虎）
//   4. **不许出现第四类错误** —— 那是一个新的拦路虎，得当场看见，不能混在旧账里没人发现
//
// 少了就骂「把基线调下来」：棘轮只往一个方向转，基线跟着走才有意义。
// 链通了（exit 0）也骂 —— 那时候该把这一门整个删掉，换成真的自编译门。
//
//   node tests/bootstrap/ratchet.js

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');

/** 基线：量出来的那三个数。**只许往下调**。
 *
 *   重名：243 -> 22 -> 10 -> 8 -> 5 -> 3 -> **0**。手法是「改导出名 + 只改调用方的
 *   `import` 那一行」（别名照旧，正文一个字不动）。
 *
 *   `import * as`：4 -> **0**。改成具名导入，`e.addImm(…)` -> `addImm(…)`，共 319 处引用。
 *   判据是「这个名字在 `encode.js` 的导出表里」——`a.kind`/`a.name`/`a.no`/`a.weak` 那个 `a`
 *   是别的局部对象，一起改就改坏了。7 处看着像遮蔽的裸名全是**类方法名**，方法名不在模块
 *   作用域绑名字，遮不住导入。
 *
 *   缺 ABI op：那两类一清，第三类就露出来了 —— 而且先露出来的是一个**假的** 266 条：
 *   `link.js` 里 `NATIVE_SUFFIX` 写的是 `src/host/native.js`，真路径是
 *   `src/core/host/native.js`，`endsWith` 一直不成立，于是 node 宿主那份实现被当成普通模块
 *   拼进程序去降级了。改成 `core/host/native.js` 之后剩 8 处，是**真**债：
 *   `readBinary`/`writeBinary`/`removeFile`/`stdoutBytes`/`stderrBytes` 这 5 个名字在
 *   `host/native.js` 里有 node 实现，但封闭 ABI（ADR-0011 决策 2）里没有对应的 op，
 *   也就没有运行时那一头。要开这一格，得三条腿一起加：C 运行时、JS prelude、解释器。 */
const BASE_DUP = 0;
const BASE_NS = 0;
const BASE_ABI = 8;

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 只走**链那一步**（`emit-js`），不编 C、不跑：0.5 秒。整条自举链在 `run.js` 里。 */
const r = spawnSync(process.execPath, [CLI, 'emit-js', CLI],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const errText = r.stderr ?? '';

if (r.status === 0) {
  bad('链通了 —— 该把这一门删掉',
    '    `omni emit-js src/core/cli.js` 回了 0：那两类债还完了。\n'
    + '    这一门的用处到此为止，换成真的自编译门（tests/bootstrap/run.js 那条）。');
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}

const lines = errText.split('\n').filter((l) => l.includes('error:'));
const dup = lines.filter((l) => l.includes('is declared at module scope in both'));
const ns = lines.filter((l) => l.includes('namespace import'));
const abi = lines.filter((l) => l.includes('is not part of the native host surface')
  || l.includes('is not in the C ABI table'));
const other = lines.filter((l) => !dup.includes(l) && !ns.includes(l) && !abi.includes(l));

/* 一、二、三：三类都不许多。少了就骂 —— 基线得跟着往下走，不然棘轮就松了。 */
for (const [name, got, base, how, pool] of [
  ['模块作用域重名', dup.length, BASE_DUP, '把新加的那个改名（模块作用域的名字在整份程序里唯一）', dup],
  ['import * as', ns.length, BASE_NS, '别再新写命名空间导入（子集里没有它，见 docs/js-bootstrap-subset.md）', ns],
  ['缺 ABI op', abi.length, BASE_ABI, '要么别在编译器里用它，要么把那个 op 三条腿一起加上（ADR-0011 决策 2）', abi],
]) {
  if (got > base) {
    const fresh = pool.slice(-3).map((l) => `      ${l.trim()}`).join('\n');
    bad(`${name} 多了：${base} -> ${got}`, `    ${how}\n    最后几条：\n${fresh}`);
  } else if (got < base) {
    bad(`${name} 少了：${base} -> ${got}（好事，可基线要跟着调）`,
      `    把 tests/bootstrap/ratchet.js 里的基线改成 ${got} —— 棘轮只往一个方向转。`);
  } else {
    ok(`${name} 还是 ${got}（基线没动）`);
  }
}

/* 四、不许出现第四类。这一条比上面三条要紧：新的拦路虎混在旧账里就没人看见了。 */
if (other.length > 0) {
  bad(`自编译多了一类新错误（${other.length} 条）`,
    `${other.slice(0, 5).map((l) => `      ${l.trim()}`).join('\n')}\n`
    + '    这不是那三类旧债 —— 它是新的拦路虎，得单独看。');
} else {
  ok('没有第四类错误（那三类之外一条都没有）');
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `（重名 ${dup.length} 条、import * as ${ns.length} 处、缺 op ${abi.length} 处）\n`);
process.exit(fail > 0 ? 1 : 0);


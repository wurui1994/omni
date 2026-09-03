// tests/bootstrap/ratchet.js —— 自编译那条链的**棘轮**（ADR-0001「量：自编译现在拦在哪儿」）
//
// 自编译现在是红的：JS 前端把 `src/core` 的 import 树链成一份程序时报两类错
// （模块作用域重名 + `import * as`）。那笔债什么时候还，是另一件事；**这一门管的是
// 它不许长大**。
//
// 为什么要有这一门：写那一节 ADR 的同一天我自己新造了一个重名（`cli/plan-c.js` 与
// `cli/plan-omni.js` 各一个 `opt`）。没有门的代价不是「有一笔旧债」，
// 而是**债会持续长出来** —— 只要那条链是红的，新的重名就没人当场拦。
//
// 三条断言：
//
//   1. 重名那一类**不许多**（基线 243 条）
//   2. `import * as` 那一类**不许多**（基线 4 处）
//   3. **不许出现第三类错误** —— 那是一个新的拦路虎，得当场看见，
//      不能混在两百多条旧账里没人发现
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

/** 基线：量出来的那两个数。**只许往下调**。
 *
 *   243 -> 22（`dedup.js` 扫了十一个文件）-> 10（守卫改成「只看要改的这一边导没导出」）
 *   -> 8（`elf.js` 的 `writeObject` 改成 `writeElfObject`、`ctype.js` 的 `typeText` 改成
 *   `cTypeText`，两处都只动了**一个**调用方）。
 *
 *   剩下这 8 条**两边都导出、而且调用方不止一处**：`ret`/`nop`/`fcmp`（arm64|x64 的
 *   `encode.js`，走的是 `import * as`，所以改的是 `a.ret` 这种属性名）、
 *   `RELOC`/`CodeBuf`（`asm.js`）、`genModule`/`genFunc`/`codeOf`（`from_mir.js`）。
 *   门里也有引用，而且 `tests/arm64/run.js` 里 `'ret'` 还是**期望的反汇编文本** ——
 *   一把梭的词边界改名会把那些字符串一起改坏，得只改属性访问。
 *
 *   4：`import * as`，四处全是 `from './encode.js'`，改名解决不了（见 ADR-0001 那一节）。 */
const BASE_DUP = 8;
const BASE_NS = 4;

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
const other = lines.filter((l) => !dup.includes(l) && !ns.includes(l));

/* 一、二：两类都不许多。少了就骂 —— 基线得跟着往下走，不然棘轮就松了。 */
for (const [name, got, base, how] of [
  ['模块作用域重名', dup.length, BASE_DUP, '把新加的那个改名（模块作用域的名字在整份程序里唯一）'],
  ['import * as', ns.length, BASE_NS, '别再新写命名空间导入（子集里没有它，见 docs/js-bootstrap-subset.md）'],
]) {
  if (got > base) {
    const fresh = (got === dup.length ? dup : ns).slice(-3).map((l) => `      ${l.trim()}`).join('\n');
    bad(`${name} 多了：${base} -> ${got}`, `    ${how}\n    最后几条：\n${fresh}`);
  } else if (got < base) {
    bad(`${name} 少了：${base} -> ${got}（好事，可基线要跟着调）`,
      `    把 tests/bootstrap/ratchet.js 里的基线改成 ${got} —— 棘轮只往一个方向转。`);
  } else {
    ok(`${name} 还是 ${got}（基线没动）`);
  }
}

/* 三、不许出现第三类。这一条比上面两条要紧：新的拦路虎混在两百多条旧账里就没人看见了。 */
if (other.length > 0) {
  bad(`自编译多了一类新错误（${other.length} 条）`,
    `${other.slice(0, 5).map((l) => `      ${l.trim()}`).join('\n')}\n`
    + '    这不是那两类旧债 —— 它是新的拦路虎，得单独看。');
} else {
  ok('没有第三类错误（那两类之外一条都没有）');
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `（重名 ${dup.length} 条、import * as ${ns.length} 处）\n`);
process.exit(fail > 0 ? 1 : 0);

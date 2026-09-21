// tests/sexpr/modules.js —— 模块（ADR-0042 第一步）**报错那一面**的判据
//
// 正面（几个模块拼起来能跑）在 `cases/52-modules.sx`，走五条腿比 stdout。
// 这一份判的是**拒绝**：边界的价值全在"说不通的时候说人话"，所以每条都核那句话本身。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'omni-mods-'));
let pass = 0;
let fail = 0;

/** 写一份 `.sx`、跑一趟、要它**非零退出**且那句话里有 `want`。 */
function refuses(name, text, want) {
  const p = join(dir, `${name}.sx`);
  writeFileSync(p, text);
  const r = spawnSync('node', [cli, 'run', p], { encoding: 'utf8', timeout: 60000 });
  const say = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && say.includes(want)) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}\n       退出码 ${r.status}\n       说的是：${say.trim().split('\n')[0]}\n       要它提到：${want}`);
}

console.log('sexpr/modules（模块的边界）');

refuses('未导出', `(module util
  (fn twice ((x int)) int (ret (bin "*" (var x) (int 2)))))
(module app
  (import util (twice))
  (main (print (call twice (int 21)))))
`, "模块 'util' 没有导出 'twice'");

refuses('没有那个模块', `(module app
  (import nope (f))
  (main (print (int 1))))
(module other (export g) (fn g () int (ret (int 0))))
`, "没有模块 'nope'");

refuses('导出了但没有这条声明', `(module util (export ghost))
(module app
  (import util (ghost))
  (main (print (int 1))))
`, "但里头没有这条声明");

refuses('一个声明两个家', `(module util
  (export twice)
  (fn twice ((x int)) int (ret (bin "*" (var x) (int 2)))))
(module app
  (import util (twice))
  (fn twice ((x int)) int (ret (var x)))
  (main (print (call twice (int 1)))))
`, '一个声明只能有一个家');

refuses('模块成环', `(module a
  (export f)
  (import b (g))
  (fn f ((x int)) int (ret (call g (var x)))))
(module b
  (export g)
  (import a (f))
  (fn g ((x int)) int (ret (call f (var x))))
  (main (print (int 0))))
`, '模块成环');

refuses('两个 main', `(module a (main (print (int 1))))
(module b (main (print (int 2))))
`, '一份程序只有一个入口');

refuses('几个模块但没名字', `(module (fn f () int (ret (int 1))))
(module (main (print (int 2))))
`, '每个都要名字');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;

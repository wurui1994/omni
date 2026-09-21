// tests/build/fixture/build.js —— 判据用的那份"别人的项目里的 build.js"
//
// 它是**一份正常的 JS**：`node build.js` 就能跑。这儿用相对路径 import 引擎
// （判据不该依赖 node_modules 里装没装 omni）；真项目里写的是
// `import { Build } from 'omni-lang/build'`。

import { Build } from '../../../src/core/build/api.js';

const b = new Build();
b.set('cflags', '-O2');
b.rule('cc', { command: 'cc $cflags -c $in -o $out', description: 'CC $out' });
b.rule('link', { command: 'cc $in -o $out' });
b.build('a.o', 'cc', 'a.c');
b.build('b.o', 'cc', 'b.c');
b.build('app', 'link', ['a.o', 'b.o']);
b.default('app');
b.run(process.argv.slice(2));

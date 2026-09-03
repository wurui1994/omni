// 宿主原生面（ADR-0011 决策 17）：从 host/native.js 导入的名字，降级之后就是 ABI op。
// node 直接跑 native.js 的实现，两个后端跑运行时里的那份 —— 这条用例保证三份一致。
// 刻意不打印任何路径：临时目录名与"程序镜像在哪"三方本来就不同。
import { mkdTemp, writeText, readText, exists, readDir, fileSize, rename, realPath, tmpDir, cwd, env } from '../../../src/core/host/native.js';
import { join, basename } from '../../../src/core/host/path.js';

const dir = mkdTemp(join(tmpDir(), "omni-native-"));
console.log(String(exists(dir)));

const a = join(dir, "a.txt");
writeText(a, "hello\nworld\n");
console.log(String(exists(a)));
console.log(String(fileSize(a)));
console.log(readText(a).split("\n").join("|"));

const b = join(dir, "b.txt");
console.log(String(exists(b)));
rename(a, b);
console.log(`${exists(a)} ${exists(b)}`);
console.log(readText(b).length === 12 ? "12 chars" : "?");

const names = readDir(dir);
console.log(`${names.length} ${names[0]}`);
console.log(basename(realPath(b)));

// cwd 三方一样（都是从同一个工作目录启动的）；env 只看类型，值本身不打印
console.log(String(cwd() === realPath(cwd())));
console.log(typeof env("PATH"));
console.log(String(env("OMNI_NO_SUCH_VAR_9x7") === undefined));

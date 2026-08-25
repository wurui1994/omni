// 宿主的路径计算是纯 JS（ADR-0011 决策 2）：这条用例保证它**降级之后**也一样。
// 与宿主 node:path 的逐项对照是另一回事（那个在开发时比过，41 项全同）。
import { join, dirname, basename, isAbsolute, resolve, relative } from '../../../stage0/src/host/path.js';

console.log(join("a", "b"));
console.log(join("/a", "b"));
console.log(join("a/", "/b"));
console.log(join("a", ".."));
console.log(join("/a", ".."));
console.log(join("/a/b", "..", "..", "lib"));
console.log(join(".", "x"));
console.log(join("..", "x"));
console.log(join("a", "", "b"));
console.log(join());
console.log(join("/"));
console.log(join("/a/b/c", "../../d"));

console.log(dirname("/a/b"));
console.log(dirname("/a"));
console.log(dirname("a"));
console.log(dirname("/"));
console.log(dirname("a/b/"));

console.log(basename("/a/b.js"));
console.log(basename("/a/b.js", ".js"));
console.log(basename("b.js", ".js"));
console.log(basename("/a/b/"));
console.log(basename(".js", ".js"));

console.log(String(isAbsolute("/a")));
console.log(String(isAbsolute("a")));

console.log(resolve("/a/b", "..", "..", "lib"));
console.log(resolve("/a", "b"));
console.log(resolve("/a", "/b"));
console.log(resolve("/a/./b/../c"));

console.log(relative("/a/b", "/a/b/c"));
console.log(`[${relative("/a/b", "/a/b")}]`);
console.log(relative("/a/b/c", "/a/d"));
console.log(relative("/a/b", "/x/y"));

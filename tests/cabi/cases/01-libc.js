// C-ABI（ADR-0014 决策 4）：从 host/native_c.js 导入的名字，降级之后就是一次真的 C 调用。
//
// 这条轴和 js-exec 那条不一样，因为它**只能在原生构建上跑**：node 宿主上没有 dlopen、
// 也没有 C 调用约定，所以 node / omni-js / interp 三条腿都按设计抛错，只有 omni-c 有输出。
// 参照因此不是 node，而是 cases/01-libc.expected。这份非对称是刻意的，见 tests/cabi/run.js。
//
// 用例只挑可移植、无副作用、结果可断言的 libc 条目：量的是**机制**（marshal 的七种类型、
// 参数个数检查、extern 原型、链接），不是 libc 本身。
import { c_abs, c_strlen, c_malloc, c_free, c_memset, c_memcmp, c_getenv, c_getpid } from '../../../src/core/host/native_c.js';

// 标量一进一出：i32 -> i32
console.log(String(c_abs(-7)));
console.log(String(c_abs(0)));
console.log(String(c_abs(123)));

// cstr 进：JS 侧是 UTF-16，marshal 转 UTF-8，所以 strlen 量的是**字节**数
console.log(String(c_strlen("hello")));
console.log(String(c_strlen("")));
console.log(String(c_strlen("héllo")));
console.log(String(c_strlen("日本語")));

// ptr 往返：句柄除了原样传回去别无用途，所以刻意不打印它的值
const p = c_malloc(8);
const q = c_malloc(8);
console.log(String(p === null));
c_memset(p, 65, 8);
c_memset(q, 65, 8);
console.log(String(c_memcmp(p, q, 8) === 0));
c_memset(q, 66, 1);
console.log(String(c_memcmp(p, q, 8) < 0));
console.log(String(c_memcmp(q, p, 8) > 0));
c_free(p);
c_free(q);

// cstr 出：没有这个环境变量时回 null 而不是 undefined —— C 那边是 NULL 指针
console.log(String(c_getenv("OMNI_NO_SUCH_VAR_9x7") === null));
console.log(String(c_getenv("PATH") === null));
console.log(typeof c_getenv("PATH"));

// 零形参，而且是**要发 extern 原型**的那一条（c_abi.js 里 c_getpid 的注释）。
// 进程号每次都不同，所以只断言它像个进程号。
console.log(String(c_getpid() > 0));
console.log(String(c_getpid() === c_getpid()));

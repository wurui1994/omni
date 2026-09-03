/**
 * 外部 C 符号的声明面（ADR-0014 决策 4）。
 *
 * 这个文件和 `host/native.js` 是同一个套路：**它的函数体只在 node 宿主上有意义**。
 * 降级的时候链接器认出这条 import 路径，把名字换成 `C_ABI` 里那一条，
 * 文件本身不会被拼进产物 —— 见 frontend-js/link.js 的 CABI_SUFFIX。
 *
 * node 宿主上没有 dlopen、也没有 C 调用约定，所以这里每一条都是抛错。这不是遗憾，
 * 是刻意的分工：C-ABI 只存在于原生构建，node 宿主继续走 JS 后端。和"C 后端只在
 * 原生构建上完整"是同一条分界线。
 *
 * 于是 `emit-js` 仍然能把整个编译器发出来（自举的不动点依赖这一点），
 * 只是那份 JS 一旦真去调 C 符号就会当场报错，而不是悄悄给个错答案。
 */

function unavailable(name) {
  throw new Error(`C ABI symbol '${name}' is only available in a native build (ADR-0014 decision 4)`);
}

export function c_abs() { return unavailable('abs'); }
export function c_strlen() { return unavailable('strlen'); }
export function c_malloc() { return unavailable('malloc'); }
export function c_free() { return unavailable('free'); }
export function c_memset() { return unavailable('memset'); }
export function c_memcmp() { return unavailable('memcmp'); }
export function c_getenv() { return unavailable('getenv'); }
export function c_getpid() { return unavailable('getpid'); }

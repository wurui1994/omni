/* 第八刀第十九片：`__asm__` 当一条**语句**。
 *
 * 只认「模板是空串、没有操作数」的那一种 —— 也就是编译屏障。macOS SDK 的
 * `dispatch_compiler_barrier()`、`os_compiler_barrier()`、`<sys/cdefs.h>` 的
 * `__compiler_barrier()` 全是这一条，编 tinycc 的源码时非过不去。
 * 我们不重排、也不把内存缓进寄存器，所以正确的实现是**一条指令都不发**。
 *
 * 三种拼法（`asm` / `__asm` / `__asm__`）、`__volatile__` 的有无、三段冒号的有无，
 * 以及顶层的那一条，都在这儿走一遍。 */
#include <stdio.h>

/* 顶层的 `__asm__(…)`（tcc 的 `asm_global_instr`） */
__asm__("");

static int step(int x)
{
	int y = x * 3;
	__asm__ __volatile__("" ::: "memory");
	y += 1;
	asm("");
	return y;
}

int main(void)
{
	int a = step(4);          /* 13 */
	int b = 0;

	for (int i = 0; i < 5; i++) {
		b += i;
		__asm__ volatile("" : : : "memory");
	}                          /* 10 */

	printf("a=%d b=%d\n", a, b);
	return a + b;              /* 23 */
}

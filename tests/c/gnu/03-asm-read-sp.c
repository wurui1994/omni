/* **读机器栈指针那条内联汇编**（`__asm__ ("mov %0, sp" : "=r" (r))`）—— `ASM_KNOWN`
 * 白名单的第一条。尺子是 clang：tcc 收不了（它的内联汇编要真发指令，而这条要我们用
 * 等价物顶），所以这一格只能放在 `gnu/`。
 *
 * 量到的出处：CPython 的 `_Py_get_machine_stack_pointer`
 * （`Include/internal/pycore_pystate.h:317`）。链 libpython 少不了它 —— `Objects/` 与
 * `Python/` 那 11 份 `.c` 全卡在这一行上。
 *
 * **问关系不问数值**：clang 那份真读 SP，我们那份给的是一格匿名局部量的地址，两个数
 * 本来就不同（所以不能逐字节比数）。能比的是这几条两边都该成立的事实：
 *   1. 取出来的值非零；
 *   2. 递归深一层再取，拿到的地址**更低**（栈往下长）；
 *   3. 两次差的绝对值不为零（每层帧至少占一格）。
 *
 * 只考 arm64 那一支：`__x86_64__` 那一支 CPython 写的是 `"{movq %%rsp, %0"`（那个 `{`
 * 是它源码里就有的），clang 收不收另说，考了这一组的尺子就没了。表里那一条照原样留着。 */
#include <stdio.h>
#include <stdint.h>

static uintptr_t machine_sp(void) {
    uintptr_t result;
#if defined(__aarch64__)
    __asm__ ("mov %0, sp" : "=r" (result));
#else
    /* CPython 自己的 `#else` 分支 —— 也就是它认的等价写法，正是我们顶上的那个 */
    char here;
    result = (uintptr_t)&here;
#endif
    return result;
}

static uintptr_t deeper(int n) {
    if (n > 0) return deeper(n - 1);
    return machine_sp();
}

int main(void) {
    uintptr_t top = machine_sp();
    uintptr_t low = deeper(3);
    printf("%d %d %d\n", top != 0, low < top, (top - low) != 0);
    return 0;
}

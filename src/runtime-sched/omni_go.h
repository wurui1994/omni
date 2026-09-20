/* omni_go.h —— 前端那一侧的门面：把 `go f(x)` 与 channel 收成**几个 C 符号**。
 *
 * 为什么要这一层（而不是让前端直接 ccall omni_newproc / omni_chansend）：
 *   1. `omni_chansend(c, ep, block)` 的第二格是**元素的地址**，而方言那一层的实参
 *      已经是机器值了，没有地方摆一格栈上的临时量 —— 这儿按值收，地址在这一侧取。
 *   2. `omni_newproc(void (*)(void *), void *)` 要一格 C 函数指针，而前端手里是
 *      **方言的函数值**（闭包对象）。那一次改写（打包实参 + 蹦床）也放在这儿。
 *   3. 主 goroutine 必须跑在 `omni_sched_main` 里（park 要能切走），所以整个
 *      `func main()` 的体是**递进来的一格函数值**，不是普通调用。
 *
 * 方言只有一格整数，所以这儿一律 `int64_t` 与不透明地址（`ptr` 在 `CABI_CORE` 里
 * 也落在 int 上）—— 见 `src/core/sexpr/lower.js` 的 CABI_CORE 那段注。
 */
#ifndef OMNI_GO_H
#define OMNI_GO_H

#include <stdint.h>

/* `func main()` 跑成**主 g**：调度器在这一句里起、主 g 一回来整个调度器收摊
   （与 Go 的 main 一样）。`fnv` 是方言的函数值，签名 `fn() -> void`。 */
void omni_go_run(void *fnv);

/* `go f(x)`：`fnv` 的签名是 `fn(int) -> void`。实参在这一侧打包（堆上一格，
   蹦床跑完就还）。 */
void omni_go_spawn(void *fnv, int64_t arg);
/* `go f()`：**不带实参**那一格单列。为什么不拿 `omni_go_spawn(f, 0)` 凑：那时按
   `fp(self, arg)` 去调一格 `fp(self)` 的函数是**对不上的函数指针类型**，多出来那格
   实参在哪个寄存器/栈位上是平台的事，不是我们说得准的。 */
void omni_go_spawn0(void *fnv);
/* `go f(a, b)` / `go f(a, b, c)`：**每个实参个数一格入口**，不拿变参凑 ——
   蹦床那一侧要按真签名的函数指针类型去调，个数说不准就是读错寄存器。
   实参一律 int64（通道/切片/指针在方言里都是一个字；`real` 那一档还没接）。 */
void omni_go_spawn2(void *fnv, int64_t a, int64_t b);
void omni_go_spawn3(void *fnv, int64_t a, int64_t b, int64_t c);

/* `make(chan T, n)` —— 元素一律 8 字节（方言只有一格整数）。回的是 hchan 的地址。 */
void *omni_go_chan_new(int64_t cap);
/* `c <- v` / `<-c` / `close(c)` / `len(c)` */
void omni_go_chan_send(void *c, int64_t v);
int64_t omni_go_chan_recv(void *c);
void omni_go_chan_close(void *c);
int64_t omni_go_chan_len(void *c);

#endif /* OMNI_GO_H */

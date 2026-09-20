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
/* `v, ok := <-c` —— 方言那一层一次调用只回**一格**值，所以拆成两句：
     `omni_go_chan_recv2(c)`  收一格，并把 ok 记在**当前这条 M 的 TLS** 里；
     `omni_go_chan_ok()`      把刚才那个 ok 取出来。
   为什么这么做是对的：两句之间**没有 park**（`recv2` 已经收完了才回），
   而 g 只在 park 那一刻才会换 M —— 所以读到的一定是自己刚写的那一格。
   这也是唯一不用"取局部量的地址"就能过的办法：方言的实参已经是机器值了。 */
int64_t omni_go_chan_recv2(void *c);
int64_t omni_go_chan_ok(void);
void omni_go_chan_close(void *c);
int64_t omni_go_chan_len(void *c);

/* ---- select（照 go 的 select.go，`omni_selectgo`） ----
 *
 * 方言那一层递不了"一个结构体数组 + 一格出参"，所以摊成**一串调用**：
 *   omni_go_sel_begin()            清空这一趟的 case 表
 *   omni_go_sel_recv(c)            加一格"收"
 *   omni_go_sel_send(c, v)         加一格"发"（v 在这儿就求好了，与 go 的求值次序一致）
 *   omni_go_sel_default()          加一格 default
 *   idx = omni_go_sel_go()         真选（回选中的下标，没有 default 且全阻塞就 park）
 *   omni_go_sel_val() / _ok()      收那一路的值与 ok
 *
 * case 表摆在**这条 M 的 TLS** 里，而 `sel_go` 进去之前先把它抄到**自己栈上**的局部量
 * —— park 之后 g 可能换 M，`omni_selectgo` 往 `elem` 里写的那一格必须跟着 g 走
 * （g 的栈跟着 g，TLS 不跟着）。这一格是这条路上唯一的真陷阱。
 */
#define OMNI_GO_SEL_MAX 16
void omni_go_sel_begin(void);
void omni_go_sel_recv(void *c);
void omni_go_sel_send(void *c, int64_t v);
void omni_go_sel_default(void);
int64_t omni_go_sel_go(void);
int64_t omni_go_sel_val(void);
int64_t omni_go_sel_ok(void);

#endif /* OMNI_GO_H */

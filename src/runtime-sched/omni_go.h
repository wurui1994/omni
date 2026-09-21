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

/* ---- 宿主那几格：时钟 / 核数 / 文件（标准库那几份桩底下的那一层） ----
 *
 * 为什么摆在这儿而不是另开一个库：这一组与上面那一批走的是**同一条路**
 * （`(lib "libomnigo")` + `(cabi …)` + `(ccall …)`，见 backend-core 的 `C_RT`），
 * 多一个库就多一份 `(lib …)` 与一次 dlopen，而这几格与并发那一批总是一起用的
 * （`time.Now()` 在 goroutine 里、PNG 在 `go r.writeImage(…)` 里）。
 *
 * **路径按字节攒**：方言那一层递不了串（`CABI_CORE` 里没有 `cstr`，见
 * `src/core/sexpr/lower.js` 的那段注），所以 `os.Create("out.png")` 是
 * "reset、逐字节 push、open" 三步。攒的那格缓冲是**一份全局的**，不是每条 M 一份
 * （`_Thread_local` 这条腿不认）—— 所以"攒名字"与"open"之间不能换 goroutine。
 * go 那侧 `os.Create` 一口气做完，中间没有 park，所以这条约定成立。
 */
int64_t omni_go_nanotime(void);
int64_t omni_go_numcpu(void);
void omni_go_path_reset(void);
void omni_go_path_push(int64_t b);
/* mode: 0 = 读、1 = 写。回**槽号**（>= 0）；打不开回 -1。 */
int64_t omni_go_open(int64_t mode);
void omni_go_write(int64_t h, int64_t b);
/* 回一格字节（0..255）；到头了回 -1。 */
int64_t omni_go_read(int64_t h);
void omni_go_close(int64_t h);
/* 往 stdout 写一格字节（`fmt.Print` 那一族 —— `print` 那格 prim 总带换行）。 */
void omni_go_out(int64_t b);

#endif /* OMNI_GO_H */

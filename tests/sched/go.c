/* tests/sched/go.c —— `omni_go.*` 那个门面的判据（与哪门前端无关，照 C 直接用）。
 *
 * 这一份**自己造方言的函数值**：一格首字段是代码地址的结构体（`omni_goclos` 那段注），
 * 所以它验的正是"前端递进来的那一格闭包对象能不能被调起来"这条接缝。
 * 形状照 bench/go/raytrace.go：主 g 撒 N 条 goroutine，每条往 channel 上发一格，
 * 主 g 收 N 次求和。
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#include "omni_go.h"

/* 方言的闭包对象：第 0 格是代码地址，后面是捕获的那几格。 */
typedef struct { void (*fp)(void); } clos0;
typedef struct { void (*fp)(void); void *ch; } clos1;

static int64_t N = 0;
static void *CH = NULL;
static int64_t SUM = 0;

/* `go worker(i)` 的体：签名 `fn(int) -> void`，约定是 fp(self, arg)。 */
static void worker(void *self, int64_t i) {
  clos1 *c = (clos1 *)self;
  omni_go_chan_send(c->ch, i * i);
}

static clos1 workerClos;

/* `func main()`：签名 `fn() -> void`，约定是 fp(self)。 */
static void goMain(void *self) {
  (void)self;
  for (int64_t i = 0; i < N; i++) omni_go_spawn(&workerClos, i);
  for (int64_t i = 0; i < N; i++) SUM += omni_go_chan_recv(CH);
  omni_go_chan_close(CH);
}

static clos0 mainClos;

int main(int argc, char **argv) {
  N = argc > 1 ? atoll(argv[1]) : 200;
  CH = omni_go_chan_new(argc > 2 ? atoll(argv[2]) : 0);
  workerClos.fp = (void (*)(void))worker;
  workerClos.ch = CH;
  mainClos.fp = (void (*)(void))goMain;

  omni_go_run(&mainClos);

  int64_t want = 0;
  for (int64_t i = 0; i < N; i++) want += i * i;
  if (SUM != want) {
    printf("平方和不对：%lld，应当是 %lld\n", (long long)SUM, (long long)want);
    return 1;
  }
  if (omni_go_chan_len(CH) != 0) {
    printf("收完了 channel 里还剩 %lld 格\n", (long long)omni_go_chan_len(CH));
    return 1;
  }
  printf("%lld 条 goroutine 的平方和 %lld ok\n", (long long)N, (long long)SUM);
  return 0;
}

/* 信号那一格的探子（第一百四十片第十五格）。**自己判自己**：一行一格 ok / FAIL。
 *
 * 为什么不比字符串而是自己判：信号装没装上，症状不是「输出不同」，是**处理函数根本不跑**
 * 或者**从处理函数返回时当场崩**（restorer 那一格错了就是这个）。所以每一格自己说结论，
 * 同一份源码用 gcc 编一遍（尺子）、用我们那台 + `--libc self` 编一遍，两边都该全 ok。
 *
 * 六格：
 *   1. 装上、`kill(getpid(), SIGUSR1)`、处理函数跑了、**回得来**（restorer 对）
 *   2. 连来三发：三次都跑，说明 restorer 不是「侥幸一次」
 *   3. 处理函数收到的 sig 号对
 *   4. `SIG_IGN`：不跑处理函数，进程也不死
 *   5. old 那格拿得回来（装 h2 时回的是 h1）
 *   6. `sigemptyset`/`sigaddset`/`sigismember`/`sigdelset` 的位算术
 *
 * `alarm` 那一格（真的定时器）单独在最后：设 1 秒，等到旗子起来或者 5 秒超时。
 *
 * **交叉编译这一份必须带 `--sysroot`**（踩过一次，差点记成 libc 的错）：
 *   node src/cli.js c obj tests/x64/libc-signal-probe.c --arch x86_64 --os linux \
 *     --sysroot src/sysroot/x86_64-linux -f elf -o /tmp/sig.o
 * 不带 `--sysroot` 时头是从**本机 macOS SDK** 里取的，而 Darwin 的 `<sys/signal.h>` 把
 * `sigemptyset`/`sigaddset`/`sigismember` 写成**宏**（`sigset_t` 在那儿是 32 位的
 * `unsigned int`）—— 于是那三格根本没调到我们的 libc，是内联的 32 位读写：清完只清了低
 * 四个字节、`sigaddset(set, 64)` 要的第 63 位落在高四个字节里，一个字都没动。
 * 症状看着像「我们的位算术错了」，其实是**尺子拿错了**。
 */
#include <stdio.h>
#include <signal.h>
#include <unistd.h>
#include <string.h>
#include <time.h>

static volatile int hits;
static volatile int lastSig;
static volatile int alarmHit;

static void h1(int s) { hits++; lastSig = s; }
static void h2(int s) { (void)s; hits += 100; }
static void onAlarm(int s) { (void)s; alarmHit = 1; }

static int fails;
static void judge(int cond, const char *what) {
  if (cond) printf("ok   %s\n", what);
  else { printf("FAIL %s\n", what); fails++; }
}

static int install(int sig, void (*fn)(int), struct sigaction *old) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = fn;
  sa.sa_flags = SA_RESTART;
  return sigaction(sig, &sa, old);
}

int main(void) {
  int me = (int)getpid();
  judge(me > 0, "getpid 回得出来");

  judge(install(SIGUSR1, h1, 0) == 0, "sigaction(SIGUSR1) 装得上");

  hits = 0; lastSig = 0;
  kill(me, SIGUSR1);
  judge(hits == 1, "打一发：处理函数跑了一次，而且回得来");
  judge(lastSig == SIGUSR1, "处理函数收到的号是 SIGUSR1");

  hits = 0;
  kill(me, SIGUSR1); kill(me, SIGUSR1); kill(me, SIGUSR1);
  judge(hits == 3, "连来三发：三次都跑");

  struct sigaction old;
  memset(&old, 0, sizeof old);
  judge(install(SIGUSR1, h2, &old) == 0 && old.sa_handler == h1,
    "old 那格回的是上一个处理函数");
  hits = 0;
  kill(me, SIGUSR1);
  judge(hits == 100, "换过的处理函数生效");

  struct sigaction ign;
  memset(&ign, 0, sizeof ign);
  ign.sa_handler = SIG_IGN;
  judge(sigaction(SIGUSR1, &ign, 0) == 0, "SIG_IGN 装得上");
  hits = 0;
  kill(me, SIGUSR1);
  judge(hits == 0, "SIG_IGN：处理函数不跑，进程也没死");

  sigset_t set;
  sigemptyset(&set);
  int a = sigismember(&set, SIGUSR1);
  sigaddset(&set, SIGUSR1);
  sigaddset(&set, 64);
  int b = sigismember(&set, SIGUSR1);
  int c = sigismember(&set, 64);
  int d = sigismember(&set, SIGALRM);
  sigdelset(&set, SIGUSR1);
  int e = sigismember(&set, SIGUSR1);
  printf("     位算术拿到的五个数：%d %d %d %d %d（该是 0 1 1 0 0）\n", a, b, c, d, e);
  judge(a == 0 && b == 1 && c == 1 && d == 0 && e == 0,
    "sigemptyset/sigaddset/sigismember/sigdelset 的位算术");

  judge(install(SIGALRM, onAlarm, 0) == 0, "sigaction(SIGALRM) 装得上");
  alarmHit = 0;
  alarm(1);
  time_t t0 = time(0);
  while (!alarmHit && time(0) - t0 < 5) { /* 等闹钟 */ }
  judge(alarmHit == 1, "alarm(1)：一秒后真的收到 SIGALRM");

  printf("%s\n", fails == 0 ? "all ok" : "有失败");
  return fails == 0 ? 0 : 1;
}

/* 第八刀第二十二片：fd 那一层（`open` / `write` / `lseek` / `read` / `close` / `unlink`）。
 *
 * 为什么在 `sys/` 而不在 `gen/`：这几个是 POSIX 的，声明在**真的系统头**里
 * （`<fcntl.h>` / `<unistd.h>`），而 `O_*` 的数值也得从那儿来 —— 自己抄一份数字
 * 就等于把「量出来的」换成「猜的」。tinycc 读源文件正是走这一层
 * （tccpp.c 的 `tcc_open` -> `open`/`read`）。
 *
 * 落在 /tmp 上、跑完自己删掉：两条腿先后跑同一份用例，用同一个名字才对得上账。 */
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

static const char *PATH = "/tmp/omni-fd-22.txt";

int main(void) {
  int sum = 0;

  /* ---- 建、写、关 */
  int fd = open(PATH, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) { printf("open-w failed\n"); return 1; }
  const char *msg = "hello fd layer\n";
  long n = write(fd, msg, strlen(msg));
  printf("write=%ld\n", n);
  sum += (int)n;
  if (close(fd) != 0) { printf("close-w failed\n"); return 2; }

  /* ---- 读回来。`read` 回的是**字节数**，读到末尾回 0 —— 这一格搞错读循环不停。 */
  fd = open(PATH, O_RDONLY);
  if (fd < 0) { printf("open-r failed\n"); return 3; }
  char buf[64];
  long got = read(fd, buf, 5);
  buf[got] = '\0';
  printf("read5=%ld [%s]\n", got, buf);
  sum += (int)got;

  /* ---- `lseek`：三种 whence 都走一遍，回的是新的绝对位置 */
  long p = lseek(fd, 6, SEEK_SET);
  printf("seek-set=%ld\n", p);
  sum += (int)p;
  p = lseek(fd, 3, SEEK_CUR);
  printf("seek-cur=%ld\n", p);
  sum += (int)p;
  p = lseek(fd, -1, SEEK_END);
  printf("seek-end=%ld\n", p);
  sum += (int)p;

  /* 末尾那一个字节，然后再读一次 —— 该回 0 */
  got = read(fd, buf, 8);
  printf("tail=%ld [%d]\n", got, buf[0]);
  got = read(fd, buf, 8);
  printf("eof=%ld\n", got);
  sum += (int)got;

  /* ---- 整份读一遍：回到头，一次要得比文件大 */
  lseek(fd, 0, SEEK_SET);
  got = read(fd, buf, sizeof(buf));
  buf[got] = '\0';
  printf("all=%ld [%s]", got, buf);
  sum += (int)got;
  close(fd);

  /* ---- fd 1/2 就是 stdout/stderr */
  write(1, "on-fd-1\n", 8);
  write(2, "on-fd-2\n", 8);

  /* ---- 删掉。删完再打开该失败。 */
  if (unlink(PATH) != 0) { printf("unlink failed\n"); return 4; }
  fd = open(PATH, O_RDONLY);
  printf("after-unlink=%d\n", fd < 0 ? -1 : 0);
  if (fd >= 0) close(fd);

  /* ---- 认不出的句柄：`close` / `read` 都该回 -1 */
  printf("bad-close=%d bad-read=%d\n", close(77) < 0 ? -1 : 0,
    read(77, buf, 1) < 0 ? -1 : 0);

  return sum & 0xff;
}

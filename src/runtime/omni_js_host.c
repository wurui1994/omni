/* node 宿主面（ADR-0011 落地顺序第 4 步）：fs / process / child_process / os
 *
 * 这一层只放**真的要问操作系统**的东西。path 那一套（join / dirname / basename /
 * resolve / relative / isAbsolute）不在这里 —— 它是纯字符串计算，写在编译器自己的
 * 源码里（src/core/host/path.js）就能两个后端一起用，塞进 ABI 只会多出一处
 * "宿主实现与我的实现是否逐字符一致"的分叉点。同理 crypto 的 sha256 也不进 ABI。
 *
 * 收发一律是 dynamic：路径与内容是 JS 域的字符串（UTF-16 码元），落到 libc 之前
 * 过一次 omni_s16_to_utf8 + omni_cstr。
 *
 * 失败一律 omni_errorf，和 node 的同步 API 抛异常对齐（try/catch 是落地顺序第 5 步，
 * 到那时这些错误会进 pending-error 槽，不需要在这里改成返回码）。
 */
#include "omni.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* ---------------------------------------------------------------- 进程状态 */

static int host_argc;
static char **host_argv;
static int host_exit_code;

void omni_host_init(int argc, char **argv) {
  host_argc = argc;
  host_argv = argv;
}

int omni_host_exit_code(void) { return host_exit_code; }

/* 入口跑在一条自己开的线程上，栈 512MB。为什么不留在主线程：那个栈的大小是链接期
   定死的（macOS 上 8MB），而这条链上最深的递归就是编译器自己 —— `emit-c` 一份 16 万行
   的 JS，词法/语法/降级三遍全是递归下降，8MB 上只剩一点余量，于是"多编译一个文件"
   就成了 Segmentation fault，看起来还像随机的。512MB 只是**保留**地址空间，页要用到
   才落地，小程序不为此付一分钱。开不出线程就退回直接调用 —— 那种机器上小程序照旧跑，
   只是没有这份余量。 */
static void (*run_entry_fn)(void);

static void *run_entry_thread(void *arg) {
  (void)arg;
  run_entry_fn();
  return NULL;
}

void omni_run_entry(void (*entry)(void)) {
  pthread_attr_t attr;
  pthread_t th;
  run_entry_fn = entry;
  if (pthread_attr_init(&attr) != 0) { entry(); return; }
  if (pthread_attr_setstacksize(&attr, (size_t)512 * 1024 * 1024) != 0
      || pthread_create(&th, &attr, run_entry_thread, NULL) != 0) {
    pthread_attr_destroy(&attr);
    entry();
    return;
  }
  pthread_attr_destroy(&attr);
  pthread_join(th, NULL);
}

/* ---------------------------------------------------------------- 小助手 */

static char *cpath(omni_dyn v) {
  return omni_cstr(omni_s16_to_utf8(omni_js_as_s16(v)));
}

static omni_dyn s16_of_cstr(const char *p) {
  omni_str s;
  s.p = p;
  s.len = (int64_t)strlen(p);
  return omni_dyn_of_s16(omni_s16_of_utf8(s));
}

static omni_dyn s16_of_bytes(const char *p, int64_t n) {
  omni_str s;
  s.p = p;
  s.len = n;
  return omni_dyn_of_s16(omni_s16_of_utf8(s));
}

/* ---- **字节串**那一档（ADR-0017 第八刀：C 的 libc 要按字节读写文件与 stdout）。
 *
 * 与上面 `s16_of_bytes` 的区别是**不解码**：一个字节一个码元（0..255），也就是 node
 * 侧那四个 op 用的 `latin1`。两条口径必须分得清 —— 拿 UTF-8 解码去读一个 `.o`
 * 会把非法序列换成 U+FFFD，字节就回不来了（而这一条腿是要写出可执行文件的）。 */
static omni_dyn s16_of_raw(const unsigned char *p, int64_t n) {
  uint16_t *u = (uint16_t *)omni_alloc_bytes((n + 1) * (int64_t)sizeof(uint16_t));
  for (int64_t i = 0; i < n; i++) u[i] = (uint16_t)p[i];
  return omni_dyn_of_s16(omni_s16_of_units(u, n));
}

/** 反过来：每个码元取低 8 位。回的缓冲由调用方用完即弃（GC 管）。 */
static unsigned char *raw_of_s16(omni_dyn v, int64_t *outLen) {
  omni_s16 s = omni_js_as_s16(v);
  unsigned char *b = (unsigned char *)omni_alloc_bytes(s.len + 1);
  for (int64_t i = 0; i < s.len; i++) b[i] = (unsigned char)(s.p[i] & 0xff);
  b[s.len] = 0;
  *outLen = s.len;
  return b;
}

/* ---------------------------------------------------------------- fs */

/* readFileSync(path, 'utf8')。一次读完：编译器读的是源文件，尺寸已知且不大。 */
omni_dyn omni_js_fs_read_text(omni_dyn path) {
  char *p = cpath(path);
  FILE *f = fopen(p, "rb");
  if (!f) omni_errorf("ENOENT: cannot read '%s': %s", p, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); omni_errorf("cannot seek '%s'", p); }
  long n = ftell(f);
  if (n < 0) { fclose(f); omni_errorf("cannot size '%s'", p); }
  rewind(f);
  char *buf = (char *)omni_alloc_bytes(n + 1);
  size_t got = n > 0 ? fread(buf, 1, (size_t)n, f) : 0;
  fclose(f);
  buf[got] = 0;
  return s16_of_bytes(buf, (int64_t)got);
}

omni_dyn omni_js_fs_write_text(omni_dyn path, omni_dyn text) {
  char *p = cpath(path);
  omni_str body = omni_s16_to_utf8(omni_js_as_s16(text));
  FILE *f = fopen(p, "wb");
  if (!f) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  if (body.len && fwrite(body.p, 1, (size_t)body.len, f) != (size_t)body.len) {
    fclose(f);
    omni_errorf("short write on '%s'", p);
  }
  if (fclose(f) != 0) omni_errorf("cannot close '%s'", p);
  return omni_dyn_undef();
}

/* 读一份**字节**（node 侧 `readBinary`：`readFileSync(p, 'latin1')`）。
 * 与 `read_text` 的区别只在不解码 —— 见 `s16_of_raw` 那一段。 */
omni_dyn omni_js_fs_read_bytes(omni_dyn path) {
  char *p = cpath(path);
  FILE *f = fopen(p, "rb");
  if (!f) omni_errorf("ENOENT: cannot read '%s': %s", p, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); omni_errorf("cannot seek '%s'", p); }
  long n = ftell(f);
  if (n < 0) { fclose(f); omni_errorf("cannot size '%s'", p); }
  rewind(f);
  unsigned char *buf = (unsigned char *)omni_alloc_bytes(n + 1);
  size_t got = n > 0 ? fread(buf, 1, (size_t)n, f) : 0;
  fclose(f);
  return s16_of_raw(buf, (int64_t)got);
}

/* 写一份字节。`mode` 只在**新建**那一刻生效，而且照旧过 umask —— 与
 * `open(…, O_CREAT, mode)` 一样（tinycc 写可执行文件给的是 0777，落下来是 0755）。 */
omni_dyn omni_js_fs_write_bytes(omni_dyn path, omni_dyn body, omni_dyn mode) {
  char *p = cpath(path);
  int64_t n = 0;
  unsigned char *b = raw_of_s16(body, &n);
  int m = mode.tag == OMNI_DYN_UNDEF ? 0666 : (int)omni_dyn_as_real(mode);
  int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, m);
  if (fd < 0) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  if (n > 0 && write(fd, b, (size_t)n) != (ssize_t)n) {
    close(fd);
    omni_errorf("short write on '%s'", p);
  }
  if (close(fd) != 0) omni_errorf("cannot close '%s'", p);
  return omni_dyn_undef();
}

bool omni_js_fs_exists(omni_dyn path) {
  struct stat st;
  return stat(cpath(path), &st) == 0;
}

bool omni_js_fs_is_dir(omni_dyn path) {
  struct stat st;
  if (stat(cpath(path), &st) != 0) return false;
  return S_ISDIR(st.st_mode) ? true : false;
}

/* statSync 的两个字段各给一个 op：编译器只读 mtimeMs 与 size（运行时对象缓存的键），
   为此造一个 stat 对象不值得。 */
omni_dyn omni_js_fs_mtime_ms(omni_dyn path) {
  char *p = cpath(path);
  struct stat st;
  if (stat(p, &st) != 0) omni_errorf("ENOENT: cannot stat '%s'", p);
#if defined(__APPLE__)
  double ms = (double)st.st_mtimespec.tv_sec * 1000.0 + (double)st.st_mtimespec.tv_nsec / 1e6;
#else
  double ms = (double)st.st_mtim.tv_sec * 1000.0 + (double)st.st_mtim.tv_nsec / 1e6;
#endif
  return omni_dyn_of_real(ms);
}

omni_dyn omni_js_fs_size(omni_dyn path) {
  char *p = cpath(path);
  struct stat st;
  if (stat(p, &st) != 0) omni_errorf("ENOENT: cannot stat '%s'", p);
  return omni_dyn_of_real((double)st.st_size);
}

/* mkdtempSync(prefix)：node 的语义是"前缀后面接六个随机字符"，正好就是 mkdtemp 的
   XXXXXX，所以直接拼上去。 */
omni_dyn omni_js_fs_mkdtemp(omni_dyn prefix) {
  omni_str pre = omni_s16_to_utf8(omni_js_as_s16(prefix));
  char *tpl = omni_cstr(omni_str_fmt("%.*sXXXXXX", (int)pre.len, pre.p));
  if (!mkdtemp(tpl)) omni_errorf("cannot mkdtemp '%s': %s", tpl, strerror(errno));
  return s16_of_cstr(tpl);
}

/* mkdirSync(p, { recursive: true })：逐段建，已存在就跳过。
   `omni bootstrap` 要摆出一棵安装布局的目录树，所以这条也得进 ABI。 */
omni_dyn omni_js_fs_mkdir_all(omni_dyn path) {
  char *p = cpath(path);
  size_t n = strlen(p);
  for (size_t i = 1; i <= n; i++) {
    if (p[i] != '/' && p[i] != '\0') continue;
    char save = p[i];
    p[i] = '\0';
    if (mkdir(p, 0777) != 0 && errno != EEXIST) {
      omni_errorf("cannot mkdir '%s': %s", p, strerror(errno));
    }
    p[i] = save;
  }
  return omni_dyn_undef();
}

omni_dyn omni_js_fs_rename(omni_dyn from, omni_dyn to) {
  char *a = cpath(from);
  char *b = cpath(to);
  if (rename(a, b) != 0) omni_errorf("cannot rename '%s' -> '%s': %s", a, b, strerror(errno));
  return omni_dyn_undef();
}

omni_dyn omni_js_fs_realpath(omni_dyn path) {
  char *p = cpath(path);
  char buf[4096];
  if (!realpath(p, buf)) omni_errorf("cannot resolve '%s': %s", p, strerror(errno));
  return s16_of_cstr(buf);
}

/* 删一个文件。不在就是错 —— 与 `unlink(2)`、与 JS 侧的 `unlinkSync` 同一个立场。 */
omni_dyn omni_js_fs_remove(omni_dyn path) {
  char *p = cpath(path);
  if (remove(p) != 0) omni_errorf("cannot remove '%s': %s", p, strerror(errno));
  return omni_dyn_undef();
}

/* ---------------------------------------------------------------- process */

omni_dyn omni_js_proc_cwd(void) {
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) omni_error("cannot read the working directory");
  return s16_of_cstr(buf);
}

/* process.env.X 的单点读取。整个 env 从没被枚举过（量过），所以不给 env 对象。 */
omni_dyn omni_js_proc_env(omni_dyn name) {
  const char *v = getenv(cpath(name));
  return v ? s16_of_cstr(v) : omni_dyn_undef();
}

/* process.env.X = v 的单点写入（ADR-0015：`-f svg` 设的就是这一格）。
   setenv 自己会把键与值各抄一份，所以 cpath 那两块临时内存不必留着。
   第三个参数 1 = 覆盖已有的那一格 —— JS 侧 `process.env.X = v` 就是覆盖。
   为什么要有"写"：格式是运行期的值，CLI 设一次，spawn 出去的子进程都继承。 */
omni_dyn omni_js_proc_set_env(omni_dyn name, omni_dyn value) {
  char *n = cpath(name);
  char *v = cpath(value);
  if (setenv(n, v, 1) != 0) omni_errorf("cannot set env '%s': %s", n, strerror(errno));
  return omni_dyn_undef();
}

omni_dyn omni_js_proc_stdout_write(omni_dyn s) {
  omni_str u = omni_s16_to_utf8(omni_js_as_s16(s));
  if (u.len) fwrite(u.p, 1, (size_t)u.len, stdout);
  return omni_dyn_undef();
}

omni_dyn omni_js_proc_stderr_write(omni_dyn s) {
  omni_str u = omni_s16_to_utf8(omni_js_as_s16(s));
  /* stdout 先冲干净：诊断和正常输出的相对次序在快照测试里是要对上的 */
  fflush(stdout);
  if (u.len) fwrite(u.p, 1, (size_t)u.len, stderr);
  fflush(stderr);
  return omni_dyn_undef();
}

/* stdout / stderr 的**字节**口径（C 的 libc 那一路：一个字符一个字节）。
 * 与上面那两条的区别同样只在不编码 —— `printf("%c", 0xff)` 要落一个 0xff 字节，
 * 过一次 UTF-8 编码就成了两个。 */
omni_dyn omni_js_proc_stdout_bytes(omni_dyn s) {
  int64_t n = 0;
  unsigned char *b = raw_of_s16(s, &n);
  if (n > 0) fwrite(b, 1, (size_t)n, stdout);
  return omni_dyn_undef();
}

omni_dyn omni_js_proc_stderr_bytes(omni_dyn s) {
  int64_t n = 0;
  unsigned char *b = raw_of_s16(s, &n);
  fflush(stdout);
  if (n > 0) fwrite(b, 1, (size_t)n, stderr);
  fflush(stderr);
  return omni_dyn_undef();
}

/* ------------------------------------------------- i32 的运算（ADR-0013 第三刀）
 * 与 `host/native.js` / `backend-js/prelude.js` 那两份是同一个 op 的三代实现，
 * 逐条对齐（分叉了就是三套语义）。值的口径：进出都是规范形的 int32，装在 real 里。
 *
 * 两处 C 特有的坑，都要显式绕开：
 *   - `INT32_MIN / -1` 与 `INT32_MIN % -1` 在 C 里是**未定义行为**（x86 上会陷入），
 *     而 JS 的 `(a/b)|0` 回的是 INT32_MIN / 0。所以这两格单列。
 *   - 有符号溢出也是 UB，所以加减乘一律在 `uint32_t` 上算完再折回来。
 */
/** ECMAScript 的 ToInt32：非有限回 0，其余对 2^32 取模再看符号。 */
static int32_t to_int32(double d) {
  if (!isfinite(d)) return 0;
  double m = fmod(trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  if (m >= 2147483648.0) m -= 4294967296.0;
  return (int32_t)m;
}

/* 进来那一格也要走 ToInt32，**不能直接 `(int32_t)double`**：C 的这个转换在超出 i32
 * 范围时是未定义行为（这台机器上是饱和），而 JS 的 `a >>> b`、`a | b` 一律先按
 * 2^32 取模。分叉的指纹很具体：`2147483648 >>> 0` 在 JS 上是 2147483648，
 * 饱和那一版会给 2147483647 —— `>>>` 接进前端那天就是这么露出来的。 */
static int32_t dyn_i32(omni_dyn v) { return to_int32(omni_dyn_as_real(v)); }

omni_dyn omni_js_i32_op(omni_dyn op, omni_dyn a, omni_dyn b) {
  omni_s16 s = omni_js_as_s16(op);
  int32_t x = dyn_i32(a);
  int32_t y = dyn_i32(b);
  uint32_t ux = (uint32_t)x;
  uint32_t uy = (uint32_t)y;
  uint16_t c0 = s.len > 0 ? s.p[0] : 0;
  uint16_t c1 = s.len > 1 ? s.p[1] : 0;
  int32_t r = 0;
  if (c0 == 'u' && c1 == '/') r = (int32_t)(ux / uy);
  else if (c0 == 'u' && c1 == '%') r = (int32_t)(ux % uy);
  else if (c0 == 'u' && c1 == '>') r = (int32_t)(ux >> (uy & 31));
  else if (c0 == '+') r = (int32_t)(ux + uy);
  else if (c0 == '-') r = (int32_t)(ux - uy);
  else if (c0 == '*') r = (int32_t)(ux * uy);
  else if (c0 == '/') r = (x == INT32_MIN && y == -1) ? INT32_MIN : x / y;
  else if (c0 == '%') r = (x == INT32_MIN && y == -1) ? 0 : x % y;
  else if (c0 == '&') r = x & y;
  else if (c0 == '|') r = x | y;
  else if (c0 == '^') r = x ^ y;
  else if (c0 == '<') r = (int32_t)(ux << (uy & 31));
  else if (c0 == '>') r = x >> (uy & 31);
  else omni_errorf("i32Op: 不认识的运算");
  return omni_dyn_of_real((double)r);
}

omni_dyn omni_js_i32_tou(omni_dyn v) {
  return omni_dyn_of_real((double)(uint32_t)dyn_i32(v));
}

omni_dyn omni_js_i32_wrap(omni_dyn v) {
  return omni_dyn_of_real((double)to_int32(omni_dyn_as_real(v)));
}

/* process.exitCode = n。真正的退出码由生成的 main 返回（见 backend-c 的 emit）。 */
omni_dyn omni_js_proc_exit_code(omni_dyn n) {
  if (n.tag == OMNI_DYN_UNDEF) { host_exit_code = 0; return omni_dyn_undef(); }
  host_exit_code = (int)omni_dyn_as_real(n);
  return omni_dyn_undef();
}

bool omni_js_proc_stdin_is_tty(void) { return isatty(0) == 1; }

/* 一行一行读标准输入，行尾的 \n 与 \r\n 都吃掉；EOF 返回 undefined。
   REPL 那边 readline 的 'line' 事件用它重写成阻塞循环 —— 事件驱动是宿主独有的东西，
   而阻塞读在两侧都成立。 */
omni_dyn omni_js_proc_read_line(void) {
  size_t cap = 128, len = 0;
  char *buf = (char *)omni_alloc_bytes((int64_t)cap);
  for (;;) {
    int ch = fgetc(stdin);
    if (ch == EOF) {
      if (len == 0) return omni_dyn_undef();
      break;
    }
    if (ch == '\n') break;
    if (len + 1 >= cap) {
      size_t ncap = cap * 2;
      char *nb = (char *)omni_alloc_bytes((int64_t)ncap);
      memcpy(nb, buf, len);
      buf = nb;
      cap = ncap;
    }
    buf[len++] = (char)ch;
  }
  if (len && buf[len - 1] == '\r') len--;
  return s16_of_bytes(buf, (int64_t)len);
}

/* 插件加载（ADR-0021 的 S4）。
 *
 * 关键是**插件也是 omni 编出来的**，与核心共用同一份运行时：状态早就搬进运行时了（S1），
 * 那个 dylib 实验也证过（核心写 realm_tbl_g[0]=7，插件读到 7）。所以插件里的 register
 * 编出来就是 dylib 里一个普通函数 —— `omni_plugin_init` 拿核心递过去的 api（一格 omni_dyn）
 * 调它一次，登记进来的是 omni_fn，注册表那一层一个字都不用改。
 *
 * 三种坏法都**响着拒**，各说清下一步：装不上（路径 / 架构 / 缺符号，dlerror 原话带上）、
 * 里头没有那个入口（不是插件，或者编的时候没导出）、以及 node 那条腿（压根没有这条路）。
 * RTLD_LOCAL：插件自己那份模板函数不该顶掉核心的同名符号，只有状态是共用的
 * （状态在核心里，靠 -Wl,-export_dynamic + 插件侧 -undefined dynamic_lookup 解析过去）。
 */
omni_dyn omni_js_plugin_load(omni_dyn path, omni_dyn api) {
  char *p = cpath(path);
  void *h = dlopen(p, RTLD_NOW | RTLD_LOCAL);
  if (h == NULL) {
    const char *e = dlerror();
    omni_errorf("插件装不上：%s（%s）", p, e == NULL ? "dlopen 没说原因" : e);
  }
  omni_dyn (*init)(omni_dyn) = (omni_dyn (*)(omni_dyn))dlsym(h, "omni_plugin_init");
  if (init == NULL) {
    omni_errorf("%s 里没有 omni_plugin_init：它不是一格 omni 插件（或者编的时候没导出）", p);
  }
  return init(api);
}

omni_dyn omni_js_os_tmpdir(void) {
  const char *t = getenv("TMPDIR");
  if (!t || !*t) t = "/tmp";
  /* node 的 tmpdir() 会削掉末尾的斜杠（除了根） */
  size_t n = strlen(t);
  while (n > 1 && t[n - 1] == '/') n--;
  return s16_of_bytes(t, (int64_t)n);
}

/* Date.now()：墙上时钟毫秒。要计的是"这一步花了多久"，而其中大头是 clang 和另一代
   编译器这些**子进程**，CPU 时间量不到它们，所以只能是墙上时间。
   刻意是 real 而不是 int：node 那边 Date.now() 是 number，两侧的 dynamic 得同类。 */
omni_dyn omni_js_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return omni_dyn_of_real((double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6);
}

/* 到此刻为止的**峰值**常驻内存，**字节**。
   单位必须在这一侧归一：`ru_maxrss` 在 macOS 上是字节、在 Linux 上是 KB（POSIX 没规定），
   而 node 那侧的 `resourceUsage().maxRSS` 一律是 KB。两个宿主各自换成字节，调用方不必
   知道自己在哪 —— 这本来就是宿主 ABI 该吸收的差异。
   刻意是 real 而不是 int：node 那边它是 number，两侧的 dynamic 得同类。 */
omni_dyn omni_js_max_rss(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return omni_dyn_of_real(0.0);
#if defined(__APPLE__)
  return omni_dyn_of_real((double)ru.ru_maxrss);
#else
  return omni_dyn_of_real((double)ru.ru_maxrss * 1024.0);
#endif
}

/* ---- 一趟"跑"的墙上时限（`omni run --timeout`，node 那侧是 host/native.js 的 runTimeout）

   这一侧只有一把闹钟，两种"跑"都靠它：
     - 本进程那一路（解释器）：处理函数把那句话写进 fd 2，然后 _exit(124)。
       不 fflush —— 信号处理函数里能用的只有异步信号安全的那几个（write 是，fflush 不是）。
     - 子进程那一路：正在 wait 的孩子记在 host_timeout_child 里，处理函数把**它**杀掉就
       回来 —— waitpid 会拿到 EINTR 之后重进，于是 omni_host_spawn 正常返回，那句话由
       上面那层（cli.js 的 runTimedOut）去印。两边都印就说两遍了。

   闹钟的分辨率是秒，所以时限向上取整到秒；node 那侧是毫秒。差别写在明处，不假装一致。 */

static volatile pid_t host_timeout_child = -1;
static char host_timeout_msg[256];
static size_t host_timeout_msg_len = 0;

static void host_timeout_alarm(int sig) {
  (void)sig;
  pid_t kid = host_timeout_child;
  if (kid > 0) {
    kill(kid, SIGKILL);
    return;
  }
  if (host_timeout_msg_len) {
    ssize_t ignored = write(2, host_timeout_msg, host_timeout_msg_len);
    (void)ignored;
  }
  _exit(124);
}

omni_dyn omni_js_run_timeout(omni_dyn ms, omni_dyn msg) {
  double m = omni_dyn_as_real(ms);
  if (!(m > 0.0)) {
    alarm(0);
    return omni_dyn_undef();
  }
  omni_str u = omni_s16_to_utf8(omni_js_as_s16(msg));
  size_t n = (size_t)u.len;
  if (n > sizeof(host_timeout_msg)) n = sizeof(host_timeout_msg);
  memcpy(host_timeout_msg, u.p, n);
  host_timeout_msg_len = n;
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = host_timeout_alarm;
  sigaction(SIGALRM, &sa, NULL);
  unsigned secs = (unsigned)((m + 999.0) / 1000.0);
  alarm(secs == 0 ? 1 : secs);
  return omni_dyn_undef();
}

/* 本地时间的日历字段，14 位数字 YYYYMMDDHHMMSS（`__DATE__` / `__TIME__` 要它）。
   一次 localtime、一个字符串：六个字段必须是同一个瞬间的（tcc 在那儿也只 time() 一次），
   而排版归编译器（frontend-c/tccpp.js）。node 那侧是 host/native.js 的 localStamp。 */
omni_dyn omni_js_local_stamp(void) {
  time_t t = time(NULL);
  struct tm lt;
  localtime_r(&t, &lt);
  char buf[16];
  size_t n = strftime(buf, sizeof buf, "%Y%m%d%H%M%S", &lt);
  return s16_of_bytes(buf, (int64_t)n);
}

/* "运行中的程序镜像所在目录"。JS 侧是 dirname(process.argv[1])，C 侧是
   dirname(argv[0])。从这里怎么走到 runtime/ 与 lib/ 是调用方的事 —— 两代的布局
   本来就不同（C0 是 src/core 下的脚本，C1 是一个可执行文件）。
   刻意**不**过 realpath：node 不解符号链接，这边解了两侧就会在 /var 与 /private/var
   这种地方分叉。相对路径按 cwd 补成绝对，因为 node 给的 argv[1] 总是绝对的。 */
omni_dyn omni_js_install_dir(void) {
  const char *exe = host_argc > 0 ? host_argv[0] : "";
  char buf[8192];
  if (exe[0] == '/') {
    snprintf(buf, sizeof buf, "%s", exe);
  } else {
    char cwd[4096];
    if (!getcwd(cwd, sizeof cwd)) omni_error("cannot read the working directory");
    snprintf(buf, sizeof buf, "%s/%s", cwd, exe);
  }
  char *slash = strrchr(buf, '/');
  if (!slash) return s16_of_cstr(".");
  if (slash == buf) return s16_of_cstr("/");
  *slash = 0;
  return s16_of_cstr(buf);
}

/* -------------------------------------------------------------- 宿主里的 eval

   `omni run` 和 REPL 在 node 上是"生成 JS，进程内 new Function 跑掉"。原生构建里
   没有 JS 引擎，所以这两个 op 只能报错。它们存在的理由是**编译器自己的源码**要能
   降级：cli.js 里那句 eval 不能写成 `new Function`（那不在封闭 ABI 里），于是变成
   一个宿主 op —— node 上有实现，原生构建上是一句清楚的错误。 */

static omni_dyn no_js_engine(void) {
  omni_error("cannot evaluate JavaScript: this is a native build with no JS engine "
             "('omni run' and 'omni repl' need the node host; try 'omni run-c')");
  return omni_dyn_undef();
}

/* 先问能力：原生构建里没有引擎。宿主的错误不是可以 catch 的异常，所以 `omni run`
   只能先问一句再决定走哪条路（cli.js 里那个分支）。 */
bool omni_js_has_engine(void) { return false; }

omni_dyn omni_js_eval(omni_dyn code) {
  (void)code;
  return no_js_engine();
}

omni_dyn omni_js_eval_captured(omni_dyn code) {
  (void)code;
  return no_js_engine();
}

/* -------------------------------------------- 给宏用的原语（结果是数组的那几个） */

/* 目录遍历：readdir 的结果是 list<dynamic>，而 list<dynamic> 只在生成的 TU 里存在
   （见 omni_js_host.h），所以这里只提供逐项迭代，装数组交给宏。
   `.` 与 `..` 跳掉，和 node 的 readdirSync 一致。 */
void *omni_host_dir_open(omni_dyn path) {
  char *p = cpath(path);
  DIR *d = opendir(p);
  if (!d) omni_errorf("ENOENT: cannot read directory '%s': %s", p, strerror(errno));
  return (void *)d;
}

const char *omni_host_dir_next(void *d) {
  for (;;) {
    struct dirent *e = readdir((DIR *)d);
    if (!e) return NULL;
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    return e->d_name;
  }
}

void omni_host_dir_close(void *d) { closedir((DIR *)d); }

int omni_host_user_argc(void) { return host_argc > 1 ? host_argc - 1 : 0; }

const char *omni_host_user_arg(int i) { return host_argv[i + 1]; }

omni_dyn omni_host_str_of_cstr(const char *p) { return s16_of_cstr(p); }

/* spawnSync。mode：'c' 全捕获、'o' stdout 直通/stderr 捕获、'i' 全直通。
   量过的三种用法正好是这三种（which / 编译单个 .c / 跑出来的可执行文件）。
   捕获用 pipe + 轮流读到 EOF：编译器的子进程输出都很小，不需要 poll 那套。 */
static omni_str omni_host_slurp(int fd) {
  size_t cap = 4096, len = 0;
  char *buf = (char *)omni_alloc_bytes((int64_t)cap);
  for (;;) {
    if (len == cap) {
      char *nb = (char *)omni_alloc_bytes((int64_t)cap * 2);
      memcpy(nb, buf, len);
      buf = nb;
      cap *= 2;
    }
    ssize_t got = read(fd, buf + len, cap - len);
    if (got < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (got == 0) break;
    len += (size_t)got;
  }
  return omni_str_new(buf, (int64_t)len);
}

/* `in` 非 NULL 就把它写进子进程的 stdin（ADR-0019 决策八：IR 走管道，磁盘不写）。
   写全了再读 stdout，靠的是一个前提：**被调的那一侧要先把 stdin 读干再往 stdout 写**
   （`glsl_host.c` 的 `slurp_stdin` 正是这样）。不满足那个前提、而且两边都超过一个管道
   缓冲（64 KB）的时候会死锁 —— 所以这一条写在这儿，不是"以后再说"。 */
int omni_host_spawn(const char *cmd, char *const *argv, int mode, const char *in,
                    omni_str *out, omni_str *err) {
  int po[2] = {-1, -1}, pe[2] = {-1, -1}, pi[2] = {-1, -1};
  bool cap_out = mode == 'c';
  bool cap_err = mode == 'c' || mode == 'o';
  bool feed = in != NULL;
  if (cap_out && pipe(po) != 0) omni_error("cannot create a pipe");
  if (cap_err && pipe(pe) != 0) omni_error("cannot create a pipe");
  if (feed && pipe(pi) != 0) omni_error("cannot create a pipe");

  pid_t pid = fork();
  if (pid < 0) omni_error("cannot fork");
  if (pid == 0) {
    if (feed) { dup2(pi[0], 0); close(pi[0]); close(pi[1]); }
    else if (mode != 'i') {
      int devnull = open("/dev/null", O_RDONLY);
      if (devnull >= 0) { dup2(devnull, 0); close(devnull); }
    }
    if (cap_out) { dup2(po[1], 1); close(po[0]); close(po[1]); }
    if (cap_err) { dup2(pe[1], 2); close(pe[0]); close(pe[1]); }
    execvp(cmd, argv);
    _exit(127);
  }
  if (cap_out) close(po[1]);
  if (cap_err) close(pe[1]);
  if (feed) {
    close(pi[0]);
    /* 子进程可能提前退（execvp 失败就是 127），那时候写会拿到 EPIPE ——
       忽略它，退出码那一步会把真相报出来。 */
    size_t n = strlen(in), off = 0;
    while (off < n) {
      ssize_t w = write(pi[1], in + off, n - off);
      if (w < 0) { if (errno == EINTR) continue; break; }
      off += (size_t)w;
    }
    close(pi[1]);
  }

  omni_str o = omni_str_new("", 0), e = omni_str_new("", 0);
  if (cap_out) o = omni_host_slurp(po[0]);
  if (cap_err) e = omni_host_slurp(pe[0]);
  if (cap_out) close(po[0]);
  if (cap_err) close(pe[0]);

  int st = 0;
  /* 挂上"正在 wait 的是谁"：时限那把闹钟到点先杀孩子（见 host_timeout_alarm），
     waitpid 拿到 EINTR 之后重进，于是这一趟正常返回，超时那句话由上面那层去印。 */
  host_timeout_child = pid;
  while (waitpid(pid, &st, 0) < 0) {
    if (errno != EINTR) {
      host_timeout_child = -1;
      omni_error("cannot wait for the child process");
    }
  }
  host_timeout_child = -1;
  *out = o;
  *err = e;
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  return 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
}

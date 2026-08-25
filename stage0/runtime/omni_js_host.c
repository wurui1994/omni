/* node 宿主面（ADR-0011 落地顺序第 4 步）：fs / process / child_process / os
 *
 * 这一层只放**真的要问操作系统**的东西。path 那一套（join / dirname / basename /
 * resolve / relative / isAbsolute）不在这里 —— 它是纯字符串计算，写在编译器自己的
 * 源码里（stage0/src/host/path.js）就能两个后端一起用，塞进 ABI 只会多出一处
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
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
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

bool omni_js_fs_exists(omni_dyn path) {
  struct stat st;
  return stat(cpath(path), &st) == 0;
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

/* "运行中的程序镜像所在目录"。JS 侧是 dirname(process.argv[1])，C 侧是
   dirname(argv[0])。从这里怎么走到 runtime/ 与 lib/ 是调用方的事 —— 两代的布局
   本来就不同（C0 是 stage0/src 下的脚本，C1 是一个可执行文件）。
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

int omni_host_spawn(const char *cmd, char *const *argv, int mode, omni_str *out, omni_str *err) {
  int po[2] = {-1, -1}, pe[2] = {-1, -1};
  bool cap_out = mode == 'c';
  bool cap_err = mode == 'c' || mode == 'o';
  if (cap_out && pipe(po) != 0) omni_error("cannot create a pipe");
  if (cap_err && pipe(pe) != 0) omni_error("cannot create a pipe");

  pid_t pid = fork();
  if (pid < 0) omni_error("cannot fork");
  if (pid == 0) {
    if (mode != 'i') {
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

  omni_str o = omni_str_new("", 0), e = omni_str_new("", 0);
  if (cap_out) o = omni_host_slurp(po[0]);
  if (cap_err) e = omni_host_slurp(pe[0]);
  if (cap_out) close(po[0]);
  if (cap_err) close(pe[0]);

  int st = 0;
  while (waitpid(pid, &st, 0) < 0) {
    if (errno != EINTR) omni_error("cannot wait for the child process");
  }
  *out = o;
  *err = e;
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  return 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
}

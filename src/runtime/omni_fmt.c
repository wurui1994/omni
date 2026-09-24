/* 值 -> 文本。两套规则，刻意分开（ADR-0005）：
   打印用 %.6g（看值用的，不追求往返）；序列化用 repr（要求 strtod 能往返回原值）。 */
#include "omni.h"
/* omni_run_proc 要 WIFEXITED/WEXITSTATUS —— omni.h 里那批标准头不含它。 */
#include <sys/wait.h>
/* omni_gfx_frame 的 `mkdir -p` 要 mkdir（同上：omni.h 里没有这一个头）。 */
#include <sys/stat.h>
/* 图形设备的 `klock()` 要 clock()/CLOCKS_PER_SEC。 */
#include <time.h>

omni_str omni_str_int(int64_t v) { return omni_str_fmt("%lld", (long long)v); }
omni_str omni_str_real(double v) { return omni_str_fmt("%.6g", v); }

/* `(tostr E N)`：按 N 位有效数字。位数由方言限死在 1..17（那里检查，这里只兜底），
   因为 %.0g 在 C 里没有定义，而超过 17 位对 double 没有意义。 */
omni_str omni_str_realg(double v, int64_t p) {
  int n = (int)p;
  if (n < 1) n = 1;
  if (n > 17) n = 17;
  return omni_str_fmt("%.*g", n, v);
}

/* `(sfix E N)`：C 的 `%.Nf`（ADR-0016 第八刀）。位数的范围是 0..30；它**不必**是字面量
   （第二十八刀 —— `printf("%.*f", n, x)` 那一行），所以越界在这儿是**运行期错误**，四条腿
   同一句话。这一条就是 C 的 printf 本身 —— 它才是那个"就近取偶"的出处，另外三条腿是照它
   写的（JS 的 toFixed 在恰好一半上进位，所以那边不能用它，见 native.js）。 */
omni_str omni_str_fixed(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sfix precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*f", (int)p, v);
}

/* `(ssci E N)`：C 的 `%.Ne`（第三十刀）。与上面同一条 —— 这一行就是那四条腿照着写的出处
   （指数至少两位、一定带符号、进位顶到下一格时指数加一，全是 C 库自己给的）。 */
omni_str omni_str_sci(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("ssci precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*e", (int)p, v);
}

/* `(sgen E N)` / `(sgenk E N)`：C 的 `%.Ng` / `%#.Ng`（第三十一刀）。这两行同样就是出处 ——
   `%g` 那一套（精度 0 等于 1、按舍入之后的指数在 `%e` 与 `%f` 里挑、`#` 不去尾随零）在这儿
   一个字都不用写，是 C 库自己给的；另外三份是照它搭出来的（见 native.js 的 fmtGen）。 */
omni_str omni_str_gen(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sgen precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%.*g", (int)p, v);
}

omni_str omni_str_genk(double v, int64_t p) {
  if (p < 0 || p > 30) omni_errorf("sgenk precision out of range: %lld (0..30)", (long long)p);
  return omni_str_fmt("%#.*g", (int)p, v);
}

omni_str omni_str_bool(bool v) { return omni_str_new(v ? "true" : "false", v ? 4 : 5); }
omni_str omni_str_string(omni_str v) { return v; }

void omni_print_int(int64_t v) { printf("%lld\n", (long long)v); }
void omni_print_real(double v) { printf("%.6g\n", v); }
void omni_print_bool(bool v) { printf("%s\n", v ? "true" : "false"); }
void omni_print_string(omni_str v) { printf("%.*s\n", (int)v.len, v.p); }

/* `(write E)` —— 印一个 string，**不加换行**（ADR-0016 第四刀）。
   jancy 的 `printf("%d ", x)` 到处都是，而 print 自带换行 —— 原先这一格只有 JS 后端有，
   于是那一侧只能把"格式串必须以 \n 收尾"当边界，那是让语言向方言妥协。
   只有 string 一个签名：要印数就在方言那一层先 (tostr …)。 */
void omni_write_string(omni_str v) { printf("%.*s", (int)v.len, v.p); }

/* `(readtext E)`：把一份文本文件**整份**读进来。核心方言里读文件只有这一个口子 ——
   asy 的 `input(name)` 那一族（line/word 的分词、注释、eof）都在被降级的语言那一侧搭，
   这里只管把字节拿到手。一次读完（不流式），与 omni_js_fs_read_text 同一条理由：
   读的是数据文件，尺寸已知。读不到就是运行期错误（asy 那边 `input(name)` 默认
   check=true，也是当场退出）。 */
omni_str omni_read_text(omni_str path) {
  char *p = omni_cstr(path);
  FILE *f = fopen(p, "rb");
  if (!f) omni_errorf("cannot read '%s': %s", p, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); omni_errorf("cannot seek '%s'", p); }
  long n = ftell(f);
  if (n < 0) { fclose(f); omni_errorf("cannot size '%s'", p); }
  rewind(f);
  char *buf = omni_alloc_bytes(n + 1);
  size_t got = n > 0 ? fread(buf, 1, (size_t)n, f) : 0;
  fclose(f);
  buf[got] = 0;
  return omni_str_new(buf, (int64_t)got);
}

/* `(getenv E)`：读宿主的一格环境设置。没这一格回空串 —— "没设"是常态，调用方拿它当
   "用默认值"（asy 的输出格式就是这么读的，见 ADR-0015）。getenv 回的那块内存是
   environ 自己的，omni_str_new 会照抄一份，所以不用管它的生命周期。 */
omni_str omni_get_env(omni_str name) {
  const char *v = getenv(omni_cstr(name));
  if (!v) return omni_str_new("", 0);
  return omni_str_new(v, (int64_t)strlen(v));
}

/* `(writetext P E)`：整份写一份文本文件。回写进去的字节数。 */
int64_t omni_write_text(omni_str path, omni_str text) {
  char *p = omni_cstr(path);
  FILE *f = fopen(p, "wb");
  if (!f) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  int64_t n = omni_str_len(text);
  if (n > 0) {
    if (fwrite(text.p, 1, (size_t)n, f) != (size_t)n) {
      fclose(f);
      omni_errorf("cannot write '%s': %s", p, strerror(errno));
    }
  }
  if (fclose(f) != 0) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  return n;
}

/* `mkdir -p`（`(gfxframe …)` 的表面默认落在 `.omni-cache/gfx/` 下，那一层可能还不在）。
   做不到就不管：真正的报错留给下面的 fopen —— 它的话（带 strerror）比这儿的清楚。 */
static void omni_mkdir_p(const char *dir) {
  char buf[4096];
  size_t n = strlen(dir);
  if (n == 0 || n >= sizeof buf) return;
  memcpy(buf, dir, n + 1);
  for (size_t i = 1; i < n; i++) {
    if (buf[i] != '/') continue;
    buf[i] = '\0';
    mkdir(buf, 0777);
    buf[i] = '/';
  }
  mkdir(buf, 0777);
}

/* `(gfxframe PATH W H FB)`：**把一帧交出去** —— 帧缓冲 FB（一格一个打包好的 0xRRGGBB
   的 double）按 W×H 写成一份 `#rgba <W> <H>\n` + 裸 RGBA（alpha 恒 255）的表面文件，
   回写进去的字节数。

   这是**第三份实现**（另两份：backend-js/prelude.js 的 `$gfx_frame`、
   interp/builtin.js 的 `gfxFrame`），三份要逐字节一致。一格颜色的读法刻意**不用位运算**：
   走 `fmod(trunc(v), 16777216)` 再绕回非负，与 JS 那两条腿（double 上取模）逐位同值 ——
   位运算那一族在 JS 里会先把 double 截到 32 位，`setcol` 收到 -1 时两边就分岔了。 */
/* 两档的公共那一半（定义在下面 —— C 里用在前、定义在后要先声明一句）。 */
static int64_t omni_gfx_emit(omni_str path, int64_t w, int64_t h,
                             struct omni_arr_f64_s *fb, const int64_t *ip);

int64_t omni_gfx_frame(omni_str path, int64_t w, int64_t h, struct omni_arr_f64_s *fb) {
  int64_t n = w * h;
  int64_t len = fb == NULL ? 0 : fb->len;
  if (len < n) {
    omni_errorf("gfxframe: framebuffer too small: %lld < %lld", (long long)len, (long long)n);
  }
  return omni_gfx_emit(path, w, h, fb, NULL);
}

/* `(gfxframe …)` 的**指针那一档**（jnc/C 那一侧：`int fb[N]` 是一段 int 槽，一槽 8 字节、
   装一个打包好的 0xRRGGBB）。范围查不了（裸指针上没有长度）—— 那一格由方言那侧的类型
   与调用方自己负责，这儿只查空。 */
int64_t omni_gfx_framep(omni_str path, int64_t w, int64_t h, int64_t *fb) {
  if (fb == NULL) omni_errorf("gfxframe: null framebuffer");
  return omni_gfx_emit(path, w, h, NULL, fb);
}

/* ---------------------------------------------------------------- PNG（默认出口）
 *
 * 8 位 RGBA、filter 0（每行前头一个 0 字节）、zlib **stored**（deflate 的未压缩块）。
 * 不引 zlib：stored 的那点格式自己写比接一个库短，而且**逐字节确定** ——
 * 压缩器换一版字节就变，"三条腿逐字节相同"那条判据就没了。
 * 与 `src/core/host/png.js` 是同一套字节（那份是 JS 那两条腿的）。 */

static uint32_t g_pngcrc[256];
static int g_pngcrc_ready = 0;

static void png_crc_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
    g_pngcrc[n] = c;
  }
  g_pngcrc_ready = 1;
}

static uint32_t png_crc_upd(uint32_t c, const unsigned char *p, size_t n) {
  if (!g_pngcrc_ready) png_crc_init();
  for (size_t i = 0; i < n; i++) c = g_pngcrc[(c ^ p[i]) & 0xFF] ^ (c >> 8);
  return c;
}

static uint32_t png_adler(const unsigned char *p, size_t n) {
  uint32_t a = 1, b = 0;
  for (size_t i = 0; i < n; i++) {
    a = (a + p[i]) % 65521u;
    b = (b + a) % 65521u;
  }
  return (b << 16) | a;
}

static void png_be32(unsigned char *d, uint32_t v) {
  d[0] = (unsigned char)(v >> 24);
  d[1] = (unsigned char)(v >> 16);
  d[2] = (unsigned char)(v >> 8);
  d[3] = (unsigned char)v;
}

/* 一格 chunk：长度 + 类型 + 数据 + CRC（CRC 算的是"类型 + 数据"）。回写出去几个字节。 */
static size_t png_chunk(FILE *f, const char *ty, const unsigned char *d, size_t n) {
  unsigned char hdr[8];
  png_be32(hdr, (uint32_t)n);
  memcpy(hdr + 4, ty, 4);
  uint32_t c = png_crc_upd(0xFFFFFFFFu, (const unsigned char *)ty, 4);
  if (n > 0) c = png_crc_upd(c, d, n);
  unsigned char tail[4];
  png_be32(tail, c ^ 0xFFFFFFFFu);
  if (fwrite(hdr, 1, 8, f) != 8) return 0;
  if (n > 0 && fwrite(d, 1, n, f) != n) return 0;
  if (fwrite(tail, 1, 4, f) != 4) return 0;
  return 12 + n;
}

/* 一帧 RGBA（第 0 行在上）-> 一份 PNG。回写出去几个字节，出错回 0。 */
static int64_t png_write(FILE *f, const unsigned char *rgba, int64_t w, int64_t h) {
  static const unsigned char sig[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
  if (fwrite(sig, 1, 8, f) != 8) return 0;
  int64_t total = 8;
  unsigned char ihdr[13];
  png_be32(ihdr, (uint32_t)w);
  png_be32(ihdr + 4, (uint32_t)h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  size_t k = png_chunk(f, "IHDR", ihdr, 13);
  if (k == 0) return 0;
  total += (int64_t)k;
  /* 原始数据（每行一个 filter 字节 + 一行 RGBA），再包成 stored 的 zlib 流。 */
  size_t rawn = (size_t)h * (1 + (size_t)w * 4);
  unsigned char *raw = (unsigned char *)malloc(rawn);
  if (raw == NULL) return 0;
  for (int64_t y = 0; y < h; y++) {
    unsigned char *dst = raw + (size_t)y * (1 + (size_t)w * 4);
    dst[0] = 0;
    memcpy(dst + 1, rgba + (size_t)y * (size_t)w * 4, (size_t)w * 4);
  }
  size_t nblk = (rawn + 65534) / 65535;
  if (nblk == 0) nblk = 1;
  size_t zn = 2 + nblk * 5 + rawn + 4;
  unsigned char *z = (unsigned char *)malloc(zn);
  if (z == NULL) { free(raw); return 0; }
  size_t zi = 0;
  z[zi++] = 0x78; z[zi++] = 0x01;
  size_t off = 0;
  while (off < rawn || rawn == 0) {
    size_t n = rawn - off > 65535 ? 65535 : rawn - off;
    z[zi++] = (unsigned char)(off + n >= rawn ? 1 : 0);
    z[zi++] = (unsigned char)(n & 255);
    z[zi++] = (unsigned char)((n >> 8) & 255);
    z[zi++] = (unsigned char)(~n & 255);
    z[zi++] = (unsigned char)((~n >> 8) & 255);
    memcpy(z + zi, raw + off, n);
    zi += n;
    off += n;
    if (rawn == 0) break;
  }
  png_be32(z + zi, png_adler(raw, rawn));
  zi += 4;
  free(raw);
  k = png_chunk(f, "IDAT", z, zi);
  free(z);
  if (k == 0) return 0;
  total += (int64_t)k;
  k = png_chunk(f, "IEND", NULL, 0);
  if (k == 0) return 0;
  return total + (int64_t)k;
}

/* 两档共用的那一半。`fb` 与 `ip` 恰有一个非空（C 里没有闭包，所以两样都传进来）。
   **整数那一档走整数取模**（不过 double）：JS 那两条腿上 int 是 BigInt，也走 BigInt 取模 ——
   于是超出 24 位的值在三条腿上是同一个字节。

   **默认写 PNG**；落点后缀是 `.rgba` 才走裸表面那个备选出口。 */
static int64_t omni_gfx_emit(omni_str path, int64_t w, int64_t h,
                             struct omni_arr_f64_s *fb, const int64_t *ip) {
  if (w <= 0 || h <= 0) {
    omni_errorf("gfxframe: bad frame size: %lldx%lld", (long long)w, (long long)h);
  }
  int64_t n = w * h;
  char *p = omni_cstr(path);
  char *cut = strrchr(p, '/');
  if (cut != NULL && cut != p) {
    char dir[4096];
    size_t dn = (size_t)(cut - p);
    if (dn < sizeof dir) {
      memcpy(dir, p, dn);
      dir[dn] = '\0';
      omni_mkdir_p(dir);
    }
  }
  size_t plen = strlen(p);
  int as_rgba = plen >= 5 && strcmp(p + plen - 5, ".rgba") == 0;
  unsigned char *pix = (unsigned char *)malloc((size_t)n * 4);
  if (pix == NULL) {
    omni_errorf("gfxframe: out of memory for a %lldx%lld frame", (long long)w, (long long)h);
  }
  for (int64_t k = 0; k < n; k++) {
    int64_t v;
    if (ip != NULL) {
      v = ip[k] % 16777216;
      if (v < 0) v += 16777216;
    } else {
      double m = fmod(trunc(fb->items[k]), 16777216.0);
      if (!isfinite(m)) m = 0.0;
      if (m < 0.0) m += 16777216.0;
      v = (int64_t)m;
    }
    pix[k * 4 + 0] = (unsigned char)((v / 65536) % 256);
    pix[k * 4 + 1] = (unsigned char)((v / 256) % 256);
    pix[k * 4 + 2] = (unsigned char)(v % 256);
    pix[k * 4 + 3] = 255;
  }
  FILE *f = fopen(p, "wb");
  if (!f) { free(pix); omni_errorf("cannot write '%s': %s", p, strerror(errno)); }
  int64_t wrote = 0;
  if (as_rgba) {
    char head[64];
    int hl = snprintf(head, sizeof head, "#rgba %lld %lld\n", (long long)w, (long long)h);
    if (fwrite(head, 1, (size_t)hl, f) != (size_t)hl
        || fwrite(pix, 1, (size_t)n * 4, f) != (size_t)n * 4) {
      free(pix); fclose(f);
      omni_errorf("cannot write '%s': %s", p, strerror(errno));
    }
    wrote = (int64_t)hl + n * 4;
  } else {
    wrote = png_write(f, pix, w, h);
    if (wrote == 0) {
      free(pix); fclose(f);
      omni_errorf("cannot write '%s': %s", p, strerror(errno));
    }
  }
  free(pix);
  if (fclose(f) != 0) omni_errorf("cannot write '%s': %s", p, strerror(errno));
  return wrote;
}

/* ---------------------------------------------------------------- 图形设备（CPU 备选）
 *
 * `(gfxcall "名字" 实参…)` 在这条腿上的落点。三档设备里的**备选**那一档 ——
 * 默认应当是真 GPU（`docs/design/eval-realtime-gpu.md` 第 2.2 节：本机 OpenGL、
 * 浏览器 WebGL2）；这一份是没有 GL 时、以及 `--gfx=cpu` 时跑的那一份。
 *
 * **像素算法与 `src/core/host/gfx-cpu.js` 逐句相同**（Bresenham、中点画圆、沿线铺圆、
 * 四舍五入取整）：两侧出来的表面要逐字节相同，那是"同一个设备两份实现"的判据。 */

static int64_t *g_gfb = NULL;         /* 一格一个 0xRRGGBB；用 int64 是为了直接喂 omni_gfx_emit */
static int64_t g_gw = 0, g_gh = 0;
static int64_t g_gcol = 0xffffff;
static double g_gx = 0.0, g_gy = 0.0;
static int g_gon = 0;
/* 帧循环那三格（与 host/gfx-cpu.js 的 D.fno / D.frames / D.dirty 一一对应）。 */
static int64_t g_gfno = 0, g_gframes = -1;
static int g_gdirty = 0;
/* 模式与性能那几格（与 host/gfx-cpu.js 的 D.mode / D.only / D.perf / D.t* 一一对应）：
   mode 0=还没读 1=render 2=view；only 是 --frame N（-1 = 每帧都交）。 */
static int g_gmode = 0, g_gperf = -1;
static int64_t g_gonly = -1, g_gtn = 0;
static double g_gtprev = 0.0, g_gtsum = 0.0, g_gtmin = 0.0, g_gtmax = 0.0;
/* 输入那几格（与 host/gfx-cpu.js 的 D.mx / D.my / D.bst / D.keys 一一对应）。
   这一档没有窗口，来源是 OMNI_MOUSE=x,y,按键位 与 OMNI_KEYS=0xc8,0x1d（按住的扫描码）。 */
static double g_gmx = 0.0, g_gmy = 0.0, g_gkeys[256];
static int64_t g_gbst = 0;
static int g_ginput = 0;

/* 把 OMNI_MOUSE / OMNI_KEYS 读一次（strtod 认十进制、strtol 带 0 认 0x 前缀）。 */
static void gfx_input(void) {
  if (g_ginput) return;
  g_ginput = 1;
  for (int i = 0; i < 256; i++) g_gkeys[i] = 0.0;
  const char *m = getenv("OMNI_MOUSE");
  if (m != NULL && m[0] != '\0') {
    char *p = (char *)m;
    g_gmx = strtod(p, &p);
    if (*p == ',') { p++; g_gmy = strtod(p, &p); }
    if (*p == ',') { p++; g_gbst = (int64_t)strtol(p, &p, 0); }
  }
  const char *k = getenv("OMNI_KEYS");
  if (k != NULL && k[0] != '\0') {
    char *p = (char *)k;
    while (*p != '\0') {
      long c = strtol(p, &p, 0);
      if (c >= 0 && c < 256) g_gkeys[c] = 1.0;
      while (*p != '\0' && *p != ',') p++;
      if (*p == ',') p++;
    }
  }
}

static int64_t gfx_rnd(double v) { return (int64_t)floor(v + 0.5); }

/* 一格整数旗子（与 host/gfx-cpu.js 的 intEnv 一字不差）。 */
static int64_t gfx_int_env(const char *name, int64_t dflt) {
  const char *v = getenv(name);
  if (v == NULL || v[0] == '\0') return dflt;
  char *e = NULL;
  long k = strtol(v, &e, 10);
  if (e == v) return dflt;
  return (int64_t)k;
}

/* render（默认）还是 view —— OMNI_GFX_MODE（CLI 的 --mode 落成它）。 */
static int gfx_mode(void) {
  if (g_gmode == 0) {
    const char *m = getenv("OMNI_GFX_MODE");
    g_gmode = (m != NULL && strcmp(m, "view") == 0) ? 2 : 1;
  }
  return g_gmode;
}

/* 墙上时间（毫秒）—— 性能那几格用它，与 JS 那侧的 nowMs 同语义。 */
static double gfx_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}

/* **录制那一档**（OMNI_GFX=null，与 host/gfx-cpu.js 的 REC 一一对应）：
   画图那一族记一笔就回 0、**一个像素都不画**，查询与帧循环那几格照旧给真答案。
   量的是"一帧里语言这一半花了多少"（与 c_impl 的 bench 同一个口径）。
   这一侧只记**总次数**（按名字分桶那张表在 JS 那边 —— 它是分析用的，不在热路径上）。 */
static int g_grec = -1;
static int64_t g_greccnt = 0;

static int gfx_rec(void) {
  if (g_grec < 0) {
    const char *m = getenv("OMNI_GFX");
    g_grec = (m != NULL && strcmp(m, "null") == 0) ? 1 : 0;
  }
  return g_grec;
}

/* 录制那一档里仍然要给真答案的那几格（与 JS 那侧的 QUERY 一字不差）。 */
static int gfx_is_query(const char *nm) {
  static const char *q[] = { "nextframe", "numframes", "klock", "xres", "yres",
    "mousx", "mousy", "bstatus", "setbstatus", "keystatus", "setkeystatus", "rgb", NULL };
  for (int i = 0; q[i] != NULL; i++) if (!strcmp(nm, q[i])) return 1;
  return 0;
}

static int64_t gfx_clamp255(double v) {
  int64_t i = gfx_rnd(v);
  return i < 0 ? 0 : (i > 255 ? 255 : i);
}

static int64_t gfx_rgb(double r, double g, double b) {
  return gfx_clamp255(r) * 65536 + gfx_clamp255(g) * 256 + gfx_clamp255(b);
}

static void gfx_need(void) {
  if (g_gon) return;
  /* 尺寸：默认 320×240，--w/--h（OMNI_GFX_W/OMNI_GFX_H）能换。 */
  g_gw = gfx_int_env("OMNI_GFX_W", 320);
  g_gh = gfx_int_env("OMNI_GFX_H", 240);
  g_gfb = (int64_t *)calloc((size_t)(g_gw * g_gh), sizeof(int64_t));
  if (g_gfb == NULL) omni_errorf("gfxcall: 开不出 %lldx%lld 的帧缓冲", (long long)g_gw, (long long)g_gh);
  g_gon = 1;
  g_gcol = 0xffffff;
  g_gx = 0.0;
  g_gy = 0.0;
}

static void gfx_px(double x, double y, int64_t c) {
  int64_t xi = gfx_rnd(x), yi = gfx_rnd(y);
  if (xi < 0 || yi < 0 || xi >= g_gw || yi >= g_gh) return;
  g_gfb[yi * g_gw + xi] = c;
  g_gdirty = 1;
}

static void gfx_line(double x0, double y0, double x1, double y1, int64_t c) {
  int64_t x = gfx_rnd(x0), y = gfx_rnd(y0), xe = gfx_rnd(x1), ye = gfx_rnd(y1);
  int64_t dx = xe > x ? xe - x : x - xe;
  int64_t dy = ye > y ? ye - y : y - ye;
  int64_t sx = x > xe ? -1 : 1, sy = y > ye ? -1 : 1, err = dx - dy;
  for (;;) {
    gfx_px((double)x, (double)y, c);
    if (x == xe && y == ye) return;
    int64_t e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

static void gfx_disc(double cx, double cy, double r, int64_t c) {
  int64_t ri = gfx_rnd(r);
  for (int64_t dy = -ri; dy <= ri; dy++) {
    int64_t dx = (int64_t)floor(sqrt((double)(ri * ri - dy * dy)));
    for (int64_t x = -dx; x <= dx; x++) gfx_px(cx + (double)x, cy + (double)dy, c);
  }
}

static void gfx_circ(double cx, double cy, double r, int64_t c) {
  int64_t x = gfx_rnd(r), y = 0, err = 1 - x;
  while (x >= y) {
    gfx_px(cx + (double)x, cy + (double)y, c);
    gfx_px(cx + (double)y, cy + (double)x, c);
    gfx_px(cx + (double)x, cy - (double)y, c);
    gfx_px(cx + (double)y, cy - (double)x, c);
    gfx_px(cx - (double)x, cy + (double)y, c);
    gfx_px(cx - (double)y, cy + (double)x, c);
    gfx_px(cx - (double)x, cy - (double)y, c);
    gfx_px(cx - (double)y, cy - (double)x, c);
    y += 1;
    if (err < 0) err += 2 * y + 1;
    else { x -= 1; err += 2 * (y - x) + 1; }
  }
}

/* ── 顶点批（`(gfxbatch 类 数 顶点)`）：**CPU 备选**那一档的落点 ──────────────
 *
 * 只有一个模型（`docs/design/eval-realtime-gpu.md` 第 9 节）：变换 / 拆 mode /
 * 2D 图元变顶点 / 合批全在语言那一侧，交到设备手里的就是**一段顶点**。GPU 那两档是
 * "上传 + 一次 draw"，这一档是软件光栅化同一段。
 *
 * 一格顶点 12 个 double：位置 x,y,z,w（**裁剪空间**）、颜色 r,g,b,a（0..1）、
 * 纹理坐标 s,t,p,q（这一档还没有纹理，收下不用）。
 * 类：0 = 线段（两个一组）、1 = 三角（三个一组）。
 */
#define GFX_VSTRIDE 12

static void gfx_vxy(const double *v, double *sx, double *sy) {
  double w = v[3] == 0.0 ? 1.0 : v[3];
  *sx = (v[0] / w * 0.5 + 0.5) * (double)g_gw;
  *sy = (0.5 - v[1] / w * 0.5) * (double)g_gh;
}

static int64_t gfx_vcol(const double *v) {
  return gfx_rgb(v[4] * 255.0, v[5] * 255.0, v[6] * 255.0);
}

/* 一格三角：包围盒 + 边函数，颜色按重心插值（与 JS 那一份同一手）。 */
static void gfx_tri(const double *a, const double *b, const double *c) {
  double ax, ay, bx, by, cx, cy;
  gfx_vxy(a, &ax, &ay);
  gfx_vxy(b, &bx, &by);
  gfx_vxy(c, &cx, &cy);
  double area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area == 0.0) return;
  int64_t x0 = (int64_t)floor(fmin(fmin(ax, bx), cx));
  int64_t x1 = (int64_t)ceil(fmax(fmax(ax, bx), cx));
  int64_t y0 = (int64_t)floor(fmin(fmin(ay, by), cy));
  int64_t y1 = (int64_t)ceil(fmax(fmax(ay, by), cy));
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > g_gw) x1 = g_gw;
  if (y1 > g_gh) y1 = g_gh;
  for (int64_t y = y0; y < y1; y++) {
    for (int64_t x = x0; x < x1; x++) {
      double px = (double)x + 0.5, py = (double)y + 0.5;
      double w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
      double w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
      if (w0 < 0.0 || w1 < 0.0 || w0 + w1 > 1.0) continue;
      double u = 1.0 - w0 - w1;
      double r = (u * a[4] + w1 * b[4] + w0 * c[4]) * 255.0;
      double g = (u * a[5] + w1 * b[5] + w0 * c[5]) * 255.0;
      double bl = (u * a[6] + w1 * b[6] + w0 * c[6]) * 255.0;
      gfx_px((double)x, (double)y, gfx_rgb(r, g, bl));
    }
  }
}

double omni_gfx_batch(int64_t kind, int64_t n, struct omni_arr_f64_s *verts) {
  if (gfx_rec()) { g_greccnt += 1; return (double)n; }
  int64_t have = verts == NULL ? 0 : verts->len;
  if (have < n * GFX_VSTRIDE) {
    omni_errorf("gfxbatch: 顶点不够（%lld 格，要 %lld）", (long long)have,
                (long long)(n * GFX_VSTRIDE));
  }
  gfx_need();
  const double *v = verts->items;
  if (kind == 0) {
    for (int64_t i = 0; i + 1 < n; i += 2) {
      const double *a = v + i * GFX_VSTRIDE, *b = a + GFX_VSTRIDE;
      double ax, ay, bx, by;
      gfx_vxy(a, &ax, &ay);
      gfx_vxy(b, &bx, &by);
      gfx_line(ax, ay, bx, by, gfx_vcol(a));
    }
    return (double)n;
  }
  if (kind == 1) {
    for (int64_t i = 0; i + 2 < n; i += 3) {
      const double *a = v + i * GFX_VSTRIDE;
      gfx_tri(a, a + GFX_VSTRIDE, a + 2 * GFX_VSTRIDE);
    }
    return (double)n;
  }
  if (kind == 2) {
    /* 点那一档：一格顶点一个像素（"一个点多大"是设备的事）。 */
    for (int64_t i = 0; i < n; i++) {
      const double *a = v + i * GFX_VSTRIDE;
      double ax, ay;
      gfx_vxy(a, &ax, &ay);
      gfx_px(ax, ay, gfx_vcol(a));
    }
    return (double)n;
  }
  omni_errorf("gfxbatch: 不认识的类 %lld（0 = 线段、1 = 三角、2 = 点）", (long long)kind);
  return 0.0;
}

/* ── 纹理（`(gfxtex 槽 宽 高 层 格 数组)`）：**CPU 备选**那一档的落点 ────────────
 *
 * 这一档没有可编程管线（采样在 `batchprog` 那格就当场报了），所以这儿**只记下这一槽
 * 的形状**（宽/高/层/格 + 给了多少个数）——像素一个都不抄：抄下来也没人采样，那是白花
 * 一份内存。GPU 那两档才真上传（`docs/design/eval-realtime-gpu.md` 第 11 节）。
 * **与 `host/gfx-cpu.js` 的 `gfxTex` 逐句相同** —— 三条腿逐字节相同是判据。
 */
#define GFX_TEXMAX 64
static struct { int64_t w, h, d, fmt, n; } g_gtex[GFX_TEXMAX];

double omni_gfx_tex(int64_t slot, int64_t w, int64_t h, int64_t d, int64_t fmt,
                    struct omni_arr_f64_s *px) {
  if (gfx_rec()) { g_greccnt += 1; return 0.0; }
  if (slot < 0 || slot >= GFX_TEXMAX) {
    omni_errorf("gfxtex: 槽 %lld 出界（0..%d）", (long long)slot, GFX_TEXMAX - 1);
  }
  if (w <= 0 || h <= 0 || d <= 0) {
    omni_errorf("gfxtex: 尺寸要是正数（%lld×%lld×%lld）", (long long)w, (long long)h,
                (long long)d);
  }
  /* 一格像素占几个 double 照原版 `evalvalperpix`：KGL_VEC4（5）是 4 个、别的都是 1 个。 */
  int64_t per = (fmt & 15) == 5 ? 4 : 1;
  int64_t want = w * h * d * per;
  int64_t have = px == NULL ? 0 : px->len;
  if (have < want) {
    omni_errorf("gfxtex: 像素不够（%lld 格，要 %lld）", (long long)have, (long long)want);
  }
  g_gtex[slot].w = w;
  g_gtex[slot].h = h;
  g_gtex[slot].d = d;
  g_gtex[slot].fmt = fmt;
  g_gtex[slot].n = want;
  return 0.0;
}

static void gfx_cone(double x0, double y0, double r0, double x1, double y1, double r1, int64_t c) {  double dx = x1 - x0, dy = y1 - y0;
  int64_t n = (int64_t)floor(sqrt(dx * dx + dy * dy) + 1.0);
  for (int64_t i = 0; i <= n; i++) {
    double t = (double)i / (double)n;
    gfx_disc(x0 + t * dx, y0 + t * dy, r0 + t * (r1 - r0), c);
  }
}

/* `refresh()`：交出这一帧 —— 写表面文件 + stdout 上印一行指针（与 JS 那一侧一字不差）。 */
static void gfx_present(void) {
  if (!g_gon) return;
  const char *p = getenv("OMNI_GFX_OUT");
  if (p == NULL || p[0] == '\0') p = ".omni-cache/gfx/frame.png";
  omni_gfx_emit(omni_str_new(p, (int64_t)strlen(p)), g_gw, g_gh, NULL, g_gfb);
  /* 指针那一行把种类带上（默认 png、`.rgba` 是备选）—— 与 host/gfx-cpu.js 一字不差。 */
  size_t pl = strlen(p);
  const char *kind = (pl >= 5 && strcmp(p + pl - 5, ".rgba") == 0) ? "rgba" : "png";
  printf("#gfx %s %s %lld %lld\n", kind, p, (long long)g_gw, (long long)g_gh);
  g_gdirty = 0;
}

/* 帧循环那几格旗子读一次（与 host/gfx-cpu.js 的 frameSetup 一字不差）。 */
static void gfx_frame_setup(void) {
  g_gonly = gfx_int_env("OMNI_GFX_FRAME", -1);
  int64_t n = g_gonly >= 0 ? g_gonly + 1 : gfx_int_env("OMNI_FRAMES", 1);
  g_gframes = n > 0 ? n : 1;
  const char *p = getenv("OMNI_GFX_PERF");
  g_gperf = (p != NULL && strcmp(p, "1") == 0) ? 1 : 0;
}

/* 一帧末：记一笔时间，再看这一帧要不要交出去。 */
static void gfx_frame_end(void) {
  double dt = gfx_now_ms() - g_gtprev;
  g_gtsum += dt;
  g_gtn += 1;
  if (g_gtn == 1 || dt < g_gtmin) g_gtmin = dt;
  if (dt > g_gtmax) g_gtmax = dt;
  if (g_gdirty && (g_gonly < 0 || g_gfno - 1 == g_gonly)) gfx_present();
}

/* 这一趟的性能账（--perf / OMNI_GFX_PERF=1 才印，落 stderr）——
   一位小数，与 host/gfx-cpu.js 的 perfReport 同一个格式。 */
static void gfx_perf_report(void) {
  if (g_gperf != 1 || g_gtn == 0) return;
  g_gperf = 2;
  double avg = g_gtsum / (double)g_gtn;
  fprintf(stderr, "#perf gfx %s frames=%lld total=%.1fms avg=%.1fms min=%.1fms max=%.1fms fps=%.1f\n",
          gfx_mode() == 2 ? "view" : "render", (long long)g_gtn,
          g_gtsum, avg, g_gtmin, g_gtmax, avg > 0.0 ? 1000.0 / avg : 0.0);
  if (gfx_rec()) fprintf(stderr, "#perf calls total=%lld\n", (long long)g_greccnt);
}

double omni_gfx_call(omni_str name, int64_t argc, double a0, double a1, double a2,
                     double a3, double a4, double a5, double a6, double a7, double a8,
                     double a9, double a10, double a11) {
  char *nm = omni_cstr(name);
  (void)a6; (void)a7; (void)a8; (void)a9; (void)a10; (void)a11;
  /* 录制那一档：记一笔，画图那一族到此为止（查询与帧循环照旧往下走）。 */
  if (gfx_rec()) {
    g_greccnt += 1;
    if (!gfx_is_query(nm)) return 0.0;
  }
  if (!strcmp(nm, "cls") && argc == 3) {
    gfx_need();
    int64_t c = gfx_rgb(a0, a1, a2);
    for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = c;
    return 0.0;
  }
  /* `cls(打包好的颜色)`：EvalDraw 里最常见的写法（`cls(0)`）—— 与 setcol/1 同一档。 */
  if (!strcmp(nm, "cls") && argc == 1) {
    gfx_need();
    int64_t c = ((int64_t)a0) & 0xffffff;
    for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = c;
    return 0.0;
  }
  /* ── 收下但这一档做不到的那几格（与 `host/gfx-cpu.js` 逐句相同）──────────────
     `framebegin` 每帧初态：GL 的状态机在语言那一侧，设备这侧只把画布清掉；
     `clz`/`gldepth`：这一档没有 z 缓冲；剩下几格（点大小/剔除/alpha/垂直同步/线宽/sleep）
     在这一档没有意思，收下记着不用。 */
  if (!strcmp(nm, "framebegin") && argc == 0) {
    gfx_need();
    for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = 0;
    g_gdirty = 1;
    return 0.0;
  }
  if (!strcmp(nm, "clz") && argc == 1) { return 0.0; }
  /* ── **收下但这一档画不出来的那几族**（与 `host/gfx-cpu.js` 逐句相同，见那份的头注）：
     纹理与贴图、体素、画布文字 —— 这一档是个平面帧缓冲，收下记着不用，图照旧出得来。 */
  if (!strcmp(nm, "pic") && argc >= 1 && argc <= 6) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 2) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "glsettex") && argc == 6) { return 0.0; }
  if (!strcmp(nm, "glgettex") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "glgettex") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "glbindtexture") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glactivetexture") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glcapture") && argc == 0) { return 0.0; }
  if (!strcmp(nm, "glcapture") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "glcaptureend") && argc == 0) { return 0.0; }
  if (!strcmp(nm, "drawspr") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "drawspr") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "drawspr") && argc == 6) { return 0.0; }
  if (!strcmp(nm, "drawkv6") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "drawkv6") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "drawkv6") && argc == 7) { return 0.0; }
  if (!strcmp(nm, "drawkv6") && argc == 8) { return 0.0; }
  if (!strcmp(nm, "drawvox") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "drawvox") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "setfont") && argc == 2) { return 0.0; }
  if (!strcmp(nm, "setfont") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "printg") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "printg") && argc == 2) { return 0.0; }
  if (!strcmp(nm, "printg") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "printg") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "printg") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "printchar") && argc >= 1 && argc <= 6) { return 0.0; }

  if (!strcmp(nm, "setview") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "setview") && argc == 7) { return 0.0; }
  if (!strcmp(nm, "glnormal") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "gltexcoord") && argc == 2) { return 0.0; }
  if (!strcmp(nm, "gltexcoord") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "gltexcoord") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "glpointsize") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glcullface") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "gllinewidth") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glswapinterval") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glalphaenable") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glalphadisable") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "sleep") && argc == 1) { return 0.0; }
  /* **深度测试**（语言那一侧的 `gl_enable(GL_DEPTH_TEST)` 转过来的）：这一档没有
     z 缓冲，收下记着不用 —— 与 `host/gfx-cpu.js` 那一份同一句话。 */
  if (!strcmp(nm, "gldepth") && argc == 1) { return 0.0; }
  /* ── **批上带的那点状态**（第四刀，与 `host/gfx-cpu.js` 逐句相同）：这一档没有
     可编程管线，所以 `batchprog` 非零是当场报（不静默按内建那对画）；那张 `u_mvp`
     与混合开关在这一档没有落点，收下记着不用。 */
  if (!strcmp(nm, "batchprog") && argc == 1) {
    if ((int64_t)a0 != 0) {
      omni_errorf("这格设备（CPU 备选）没有可编程管线 —— 脚本挑了自己那格 program"
                  "（glsetshader），顶点是物体坐标，这一档接不了；要 GPU 那两档设备"
                  "（浏览器 WebGL2 / 本机 OpenGL）");
    }
    return 0.0;
  }
  if (!strcmp(nm, "batchmvp") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "batchblend") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "setcol") && argc == 3) { gfx_need(); g_gcol = gfx_rgb(a0, a1, a2); return 0.0; }  if (!strcmp(nm, "setcol") && argc == 1) { gfx_need(); g_gcol = ((int64_t)a0) & 0xffffff; return 0.0; }
  if (!strcmp(nm, "setpix") && argc == 2) { gfx_need(); gfx_px(a0, a1, g_gcol); return 0.0; }
  if (!strcmp(nm, "moveto") && argc == 2) { gfx_need(); g_gx = a0; g_gy = a1; return 0.0; }
  if (!strcmp(nm, "lineto") && argc == 2) {
    gfx_need();
    gfx_line(g_gx, g_gy, a0, a1, g_gcol);
    g_gx = a0;
    g_gy = a1;
    return 0.0;
  }
  /* `drawsph(x,y,r)`：半径为负是描边（evaldraw_ref.md）。 */
  if (!strcmp(nm, "drawsph") && argc == 3) {
    gfx_need();
    if (a2 < 0) gfx_circ(a0, a1, -a2, g_gcol);
    else gfx_disc(a0, a1, a2, g_gcol);
    return 0.0;
  }
  if (!strcmp(nm, "drawcone") && argc == 6) {
    gfx_need();
    gfx_cone(a0, a1, a2, a3, a4, a5, g_gcol);
    return 0.0;
  }
  if (!strcmp(nm, "rgb") && argc == 3) return (double)gfx_rgb(a0, a1, a2);
  if (!strcmp(nm, "refresh") && argc == 0) { gfx_need(); gfx_present(); return 0.0; }
  /* **帧循环那一格**（与 host/gfx-cpu.js 的 nextframe 一字不差）：产物自己 while 着问它
     "还画不画下一帧" —— 于是循环在设备里。这一档画 OMNI_FRAMES 帧（默认 1）。 */
  if (!strcmp(nm, "nextframe") && argc == 0) {
    gfx_need();
    if (g_gframes < 0) gfx_frame_setup();
    if (g_gfno > 0) gfx_frame_end();
    if (g_gfno >= g_gframes) { gfx_perf_report(); return 0.0; }
    g_gfno += 1;
    g_gtprev = gfx_now_ms();
    return 1.0;
  }
  if (!strcmp(nm, "numframes") && argc == 0) { gfx_need(); return (double)(g_gfno > 0 ? g_gfno - 1 : 0); }
  /* `klock()`：秒。**render 模式下是确定性时钟**（帧号 / 60，照 c_impl 的 1/60 clock scale）
     —— 与 host/gfx-cpu.js 那一格一字不差，所以三条腿仍然逐字节相同。view 模式才是墙上时间。 */
  if (!strcmp(nm, "klock") && argc == 0) {
    return gfx_mode() == 2 ? gfx_now_ms() / 1000.0
                           : (double)(g_gfno > 0 ? g_gfno - 1 : 0) / 60.0;
  }
  /* `klock(i)`：0 与 klock() 同；|i| 在 1..9 是日期分量（i>0 本地、i<0 UTC）——
     口径照 polydraw_src/polydraw.c:1662 的 myklock，与 host/gfx-cpu.js 的 klockParts 同。 */
  if (!strcmp(nm, "klock") && argc == 1) {
    int i = (int)a0;
    if (i == 0) {
      return gfx_mode() == 2 ? gfx_now_ms() / 1000.0
                             : (double)(g_gfno > 0 ? g_gfno - 1 : 0) / 60.0;
    }
    if (i > -10 && i < 10) {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      time_t t = (time_t)ts.tv_sec;
      struct tm tmv;
      if (i < 0) gmtime_r(&t, &tmv); else localtime_r(&t, &tmv);
      int msec = (int)(ts.tv_nsec / 1000000);
      int k = i < 0 ? -i : i;
      int y = tmv.tm_year + 1900, mo = tmv.tm_mon + 1, d = tmv.tm_mday;
      if (k == 1) {
        double q = ((((((double)y * 100 + mo) * 100 + d) * 100 + tmv.tm_hour) * 100
                     + tmv.tm_min) * 100 + tmv.tm_sec) * 1000 + msec;
        return q * 0.001;
      }
      if (k == 2) return (double)y;
      if (k == 3) return (double)mo;
      if (k == 4) return (double)tmv.tm_wday;
      if (k == 5) return (double)d;
      if (k == 6) return (double)tmv.tm_hour;
      if (k == 7) return (double)tmv.tm_min;
      if (k == 8) return (double)tmv.tm_sec;
      if (k == 9) return (double)msec;
    }
    return 0.0;
  }
  /* `FRAMEINIT` 与 `getpix`（与 `host/gfx-cpu.js` 逐句相同）。 */
  if (!strcmp(nm, "frameinit") && argc == 0) { gfx_need(); return g_gfno <= 1 ? 1.0 : 0.0; }
  if (!strcmp(nm, "getpix") && argc == 2) {
    gfx_need();
    int64_t gx = (int64_t)a0, gy = (int64_t)a1;
    if (gx < 0 || gy < 0 || gx >= g_gw || gy >= g_gh) return 0.0;
    return (double)g_gfb[gy * g_gw + gx];
  }
  if (!strcmp(nm, "xres") && argc == 0) { gfx_need(); return (double)g_gw; }
  if (!strcmp(nm, "yres") && argc == 0) { gfx_need(); return (double)g_gh; }
  /* 输入那一族（与 host/gfx-cpu.js 的那几格一字不差）：这一档没有窗口，来源是
     OMNI_MOUSE / OMNI_KEYS，所以三条腿仍然逐字节相同。写的两格照 polydraw.txt:381/:388。 */
  if (!strcmp(nm, "mousx") && argc == 0) { gfx_input(); return g_gmx; }
  if (!strcmp(nm, "mousy") && argc == 0) { gfx_input(); return g_gmy; }
  if (!strcmp(nm, "bstatus") && argc == 0) { gfx_input(); return (double)g_gbst; }
  if (!strcmp(nm, "setbstatus") && argc == 1) { gfx_input(); g_gbst = (int64_t)a0; return 0.0; }
  if (!strcmp(nm, "keystatus") && argc == 1) {
    gfx_input();
    int64_t k = (int64_t)a0;
    return (k >= 0 && k < 256) ? g_gkeys[k] : 0.0;
  }
  if (!strcmp(nm, "setkeystatus") && argc == 2) {
    gfx_input();
    int64_t k = (int64_t)a0;
    if (k >= 0 && k < 256) g_gkeys[k] = a1;
    return 0.0;
  }
  omni_errorf("这格设备（CPU 备选）上没有 '%s'（%lld 个实参）—— 有的是 "
              "cls/setcol/setpix/moveto/lineto/drawsph/drawcone/rgb/refresh/"
              "nextframe/numframes/klock/xres/yres/mousx/mousy/bstatus/keystatus；"
              "GL 立即模式与可编程管线（着色器）只有 GPU 那两档设备有"
              "（见 docs/design/eval-realtime-gpu.md）",
              nm, (long long)argc);
  return 0.0;
}

/* `(gfxframefn …)`：把每帧那一格函数交给设备。这条腿上**记下不用** ——
   CPU 备选（上面那一摊）与本机 OpenGL 那一档自己有帧循环（`nextframe` 那一格）。
   留着这个符号是为了"一格 op 四条腿都认得"：少了它 `--backend c` 会当场报。 */
static void *g_gframefn = NULL;

double omni_gfx_frame_fn(void *f) {
  g_gframefn = f;
  return 0.0;
}

/* `(gfxdef 种类 名字 内容)`：往设备上登记一格有名字的串。CPU 备选这一档**记下不用**
   —— 可编程管线那一族在这儿没有落点（真去 `glsetshader` 才报，报里说清是哪一格）。
   留着这个符号是为了"一格 op 四条腿都认得"。 */
double omni_gfx_def(omni_str kind, omni_str name, omni_str text) {
  (void)kind; (void)name; (void)text;
  return 0.0;
}

/* `(runproc CMD)`：`/bin/sh -c CMD`，回退出码。子进程的两个流都丢掉 —— 这一层的
   stdout 是产物本身（asy 那边就是 EPS），被调程序的絮絮叨叨混进去会把图弄坏。
   **必须套一层子 shell**：`CMD >/dev/null` 里的重定向只管命令表的最后一条，
   量出来过 —— `echo LEAK; echo LEAK 1>&2 >/dev/null 2>&1` 照样把第一个 LEAK 印出来，
   而 `printf ok > f >/dev/null 2>&1` 后面那个重定向赢了，f 里什么都没有。
   `(` 与 `)` 之间垫一个换行：CMD 末尾要是个 `#注释`，`)` 会被注掉。
   跑不起来（system 回 -1）回 127，与 JS 那条腿一致。

  **stdin 也必须重定向** —— 而且不是"讲究"，是量出来的病：asy 的 `_texpath` 要拿 gs 跑
  一份 .ps 换轮廓，gs 打了 `-P` 仍会在行尾印 `>>showpage, press <return> to continue<<`
  然后**读一行 stdin** 等回车。`system()` 的两个流是继承的，stdin 于是还是那个终端 ——
  永不 EOF，于是 `run-c tests/asy/examples/bars3.asy` 输出全写完（6 MB，连 `%%EOF` 都在）
  却永远不退出，`timeout 60` 只能杀掉（参考 asy 自己 3.585s）。给 `< /dev/null` 就 4.7s
  正常收工，量得清清楚楚。
  JS 那条腿（backend-js/prelude.js 的 `$run_proc`）用 `stdio: ["ignore", ...]`，天生没有
  这一格；C 这边的 `system()` 没有那个开关，所以只能在命令行上补 —— 与另外两个流同一处。 */
int64_t omni_run_proc(omni_str cmd) {
  char *c = omni_cstr(cmd);
  size_t n = strlen(c);
  size_t cap = n + 40;
  char *line = omni_alloc_bytes((int64_t)cap);
  snprintf(line, cap, "( %s\n) </dev/null >/dev/null 2>&1", c);
  int r = system(line);
  if (r == -1) return 127;
  if (WIFEXITED(r)) return WEXITSTATUS(r);
  return 128;
}

/* 末尾补 ".0"：否则整数值的 real 序列化成 "1000"，再解析回来就变成 int 了 ——
   往返要保类型，不只是保数值。 */
static omni_str omni_repr_tail(const char *s) {
  if (strchr(s, '.') || strchr(s, 'e')) return omni_str_fmt("%s", s);
  return omni_str_fmt("%s.0", s);
}

/* 取 15/16/17 位里第一个能往返的：这是"最短往返"的廉价近似，不需要 Grisu/Ryu，
   而且两个后端做的是同一件事，结果逐位一致。 */
omni_str omni_repr_real(double v) {
  if (!isfinite(v)) omni_error("cannot represent non-finite real");
  char buf[64];
  for (int p = 15; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*g", p, v);
    if (strtod(buf, NULL) == v) return omni_repr_tail(buf);
  }
  snprintf(buf, sizeof buf, "%.17g", v);
  return omni_repr_tail(buf);
}

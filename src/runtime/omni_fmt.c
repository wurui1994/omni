/* 值 -> 文本。两套规则，刻意分开（ADR-0005）：
   打印用 %.6g（看值用的，不追求往返）；序列化用 repr（要求 strtod 能往返回原值）。 */
#include "omni.h"
/* omni_run_proc 要 WIFEXITED/WEXITSTATUS —— omni.h 里那批标准头不含它。 */
#if !defined(_WIN32) || defined(__OMNI_LIBC__)
#include <sys/wait.h>
#else
#include "omni_win32.h"   /* WIFEXITED/WEXITSTATUS 的替代 */
#endif
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
/* **暖态那一段**（跳过头 `g_gskip` 帧之后的那些）：头一帧要编着色器、建 FBO、暖纹理，
   把它算进 avg 会让"几帧的探针"量出三倍的数（量到过：同一条腿 4 帧 42ms / 27 帧 6.5ms）。
   所以 avg/min/max 只统暖态，`total` 照旧是全部 —— 于是"启动"那一段（real − warm）
   自然把头一帧的编译含进去，它本来就属于"改完到看见画面"。
   `OMNI_GFX_PERF_SKIP` 改跳几帧（缺省 1）；只有一帧时不跳（不然一个数都没有）。 */
static int64_t g_gskip = 1, g_gwn = 0;
static double g_gwsum = 0.0, g_gwmin = 0.0, g_gwmax = 0.0;
/* 输入那几格（与 host/gfx-cpu.js 的 D.mx / D.my / D.bst / D.keys 一一对应）。
   这一档没有窗口，来源是 OMNI_MOUSE=x,y,按键位 与 OMNI_KEYS=0xc8,0x1d（按住的扫描码）。 */
/* 开局那个位置是 (320,240) —— 原版一开机光标在窗口正中（默认窗口 640×480），
   参考也这么定死（`c_impl/src/pd_polyhost.c:22`）。与 `gfx-cpu.js` 的 `D.mx/my` 同值。 */
static double g_gmx = 320.0, g_gmy = 240.0, g_gkeys[256];
static int64_t g_gbst = 0;
static int g_ginput = 0;

/* 把 OMNI_MOUSE / OMNI_KEYS 读一次（strtod 认十进制、strtol 带 0 认 0x 前缀）。
   **窗口那一档**（`--mode view`）例外：来源是窗口，所以每次都重新问一遍 ——
   那一格在下面 `gfx_input_win`，由 `gfx_input` 先试。 */
static int gfx_input_win(void);
static void gfx_input(void) {
  if (gfx_input_win()) return;
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

/* ── **本机 OpenGL 那一档**（`OMNI_GFX=gl`）：dlopen 那份插件，把批转给 GPU ──────────
 *
 * 口径 `docs/design/eval-realtime-gpu.md` §13.8。挂法照三维那一档（`omni_r3.c` 的
 * `r3_gl_entry`）：主体运行时对 GL **零编译期依赖**（只两句 extern，不 include 任何 GL 头
 * —— tcc 那条腿也要编这份文件），库在运行期 `dlopen`，路径由 `cli.js` 摆进 `OMNI_GL_LIB`。
 *
 * **挂不上就回落**：没有 `OpenGL.framework`、编不过、`open` 回非 0 —— 一律退回上面那一摊
 * CPU 备选。`OMNI_GFX=gl` 是"想要"，不是"必须"（与 `OMNI_R3_BACKEND` 同一手）。
 *
 * **两层怎么合**：GPU 画的是顶点批（`(gfxbatch …)`）；`setpix`/`lineto`/`drawsph` 那一族
 * 仍然落在宿主这一侧的帧缓冲上（语言那一侧没把它们变顶点 —— 见 §9）。所以 GL 开着的时候
 * 宿主那格帧缓冲的初值是 **-1 = 这一格没人画**，交帧时 GPU 那一层当底、宿主那一层盖上去。
 */
#define GFX_RTLD_NOW 2
/* 手写这两句而不是 `#include <dlfcn.h>`：tcc 那条腿也要编这份文件（见上面那段）。
 * **Windows + MSVC 的 CRT 那条腿除外**：那边没有 `dlopen` 这个符号，声明得出来、链不出来
 * （`lld-link: error: undefined symbol: dlopen`）—— 那一格在 omni_win32.h 里（`static`，
 * 这份文件开头已经包过了，所以这儿只要别再声明一遍）。 */
#if !defined(_WIN32) || defined(__OMNI_LIBC__)
extern void *dlopen(const char *, int);
extern void *dlsym(void *, const char *);
#endif


typedef int (*gfx_gl_open_fn)(int, int);
typedef void (*gfx_gl_cls_fn)(unsigned int);
typedef void (*gfx_gl_depth_fn)(int);
typedef void (*gfx_gl_batch_fn)(int, long, const double *);
typedef int (*gfx_gl_read_fn)(unsigned char *);
typedef const char *(*gfx_gl_err_fn)(void);
/* 可编程管线与纹理那几格（第五刀最后一格）—— 老库上 dlsym 不到就当这一族没有。 */
typedef void (*gfx_gl_def_fn)(const char *, const char *, const char *);
typedef int (*gfx_gl_shader_fn)(int, const double *);
typedef double (*gfx_gl_loc_fn)(double);
typedef int (*gfx_gl_uni_fn)(double, int, const double *);
typedef int (*gfx_gl_uni1i_fn)(double, double);
typedef int (*gfx_gl_attr_fn)(double, const double *);
typedef void (*gfx_gl_int_fn)(int);
typedef void (*gfx_gl_mvp_fn)(int, double, double, double, double);
typedef int (*gfx_gl_tex_fn)(int, int, int, int, int, const double *);
typedef int (*gfx_gl_texfile_fn)(int, const char *, int);
/* `gluniform*v`（句柄, 分量数, 整数吗, 个数, 数组）与 `glgettex`（槽, 宽, 高, 上限, 出）。 */
typedef int (*gfx_gl_univ_fn)(double, int, int, long, const double *);
typedef int (*gfx_gl_gettex_fn)(int, int, int, long, double *);
/* **抓屏那一族**（`glcapture 边长` / `glcaptureend 槽`，§22）：语言那一侧发的是
   一参那两格，矩阵那一半在它那儿；设备这侧只换视口 + 一次 `glCopyTexImage2D`。 */
typedef int (*gfx_gl_cap_fn)(int);
/* **窗口那一档**（`--mode view`，任务 #24）：开窗口 / 交一帧 / 读输入 / 写标题。
   老库上 dlsym 不到就当这一族没有 —— 那就还是离屏（与"挂不上就回落"同一手）。 */
typedef int (*gfx_gl_win_fn)(int, int, const char *);
typedef int (*gfx_gl_winpresent_fn)(const unsigned char *);
typedef int (*gfx_gl_wininput_fn)(double *, double *, long *, unsigned char *);
typedef void (*gfx_gl_wintitle_fn)(const char *);

static struct {
  int tried, on;
  gfx_gl_open_fn open;
  gfx_gl_cls_fn cls;
  gfx_gl_depth_fn depth;
  gfx_gl_batch_fn batch;
  gfx_gl_read_fn read;
  gfx_gl_err_fn err;
  gfx_gl_def_fn def;
  gfx_gl_shader_fn shader;
  gfx_gl_loc_fn uniloc, attrloc;
  gfx_gl_uni_fn uni;
  gfx_gl_uni1i_fn uni1i;
  gfx_gl_attr_fn attr;
  gfx_gl_int_fn prog, blend, bindtex, activetex, cull;
  gfx_gl_mvp_fn mvp, mv;
  gfx_gl_tex_fn tex;
  gfx_gl_texfile_fn texfile;
  gfx_gl_univ_fn univ;
  gfx_gl_gettex_fn gettex;
  gfx_gl_cap_fn capbegin, capend;
  gfx_gl_win_fn win;
  gfx_gl_winpresent_fn winpresent;
  gfx_gl_wininput_fn wininput;
  gfx_gl_wintitle_fn wintitle;
} g_gl;

/* 窗口那一档活着没有（0 = 离屏那一半）。关掉之后置 0 —— `nextframe` 看它收摊。
   `g_glwin_was` 记"开过窗口" —— 两格分开是因为"从来没开出来（回落离屏）"与
   "开过、现在关了"要走的路不一样：前者照旧按帧数跑完，后者立刻收摊。 */
static int g_glwin = 0, g_glwin_was = 0;
/* **这一次 body 里 `refresh` 来了几回**（`nextframe` 那一格清零）。
   EvalDraw 那一族把 `while(1){ …; refresh(); }` 写在脚本里 —— 一次 body 里会来很多回，
   `refresh` 那一格据此分流（见那儿的注）。 */
static long g_grefr = 0;

/* **`klock` 在这一帧里来了第几回** + 上一回给出去的值（帧号一推就清零）。见 gfx_klock_sec。 */
static long g_gkn = 0;
static double g_gklast = 0.0;

/* **`klock()` 的零点**（view 模式才用得上）。正本里它是 `qtim0`，**在编译那一刻重置**
   （`polydraw_src/polydraw.c:2259`，与 `dnumframes = 0` 同一句；1669 行的注释写着
   "0=seconds since compile"）—— 我们这儿对应"这一趟开跑"（`gfx_frame_setup`）。
   从前 view 模式直接回 `gfx_now_ms()/1000` = **CLOCK_MONOTONIC（开机至今）**，
   于是脚本头一帧的 `dtim = klock() - 0` 是几十万秒：`ken/balls.pss` 的球第二帧就被
   推到几千万像素外，画面**从第二帧起全黑**（"只闪一帧然后变黑"就是这一格）。 */
static double g_gkt0 = -1.0;

/* `klock()` / `klock(0)` 的秒数 —— 与 host/gfx-cpu.js 的 `klockSec()` 同一句话：
   view 模式是真墙上时间；render 模式是确定性时钟（帧号/60），**但同一帧里第二次起
   往前走一帧的量**（语料里有"把帧限速写在脚本里"那个写法：
   `otim = tim; do { tim = klock(); } while (tim-otim < 1/60);` —— magpong2 那一族。
   钉死的时钟让它永远出不来）。一帧读一次的脚本逐字节不变。 */
static double gfx_klock_sec (void) {
  double base, v;
  if (gfx_mode() == 2) {
    /* view：墙上时间，**从这一趟开跑算起**（见 `g_gkt0` 那段）。 */
    if (g_gkt0 < 0) g_gkt0 = gfx_now_ms();
    return (gfx_now_ms() - g_gkt0) / 1000.0;
  }

  base = (double)(g_gfno > 0 ? g_gfno - 1 : 0) / 60.0;
  if (g_gkn == 0) { g_gkn = 1; g_gklast = base; return base; }
  v = base + (double)g_gkn / 60.0;
  if (v < g_gklast + 1.0 / 60.0) v = g_gklast + 1.0 / 60.0;
  g_gkn += 1; g_gklast = v;
  return v;
}

/* 窗口那一档的输入：**每次都重新问**（鼠标在动、键在按）。回 1 = 这一档管了。
   `mousx/mousy` 按画布坐标（设备那侧按窗口/帧缓冲比例折算过），`keystatus[]` 按
   DOS 扫描码 —— 与 `OMNI_MOUSE`/`OMNI_KEYS` 那一档同一套口径，所以脚本一个字不用改。 */
static int gfx_input_win(void) {
  if (!g_glwin || g_gl.wininput == NULL) return 0;
  unsigned char ks[256];
  long b = 0;
  if (g_gl.wininput(&g_gmx, &g_gmy, &b, ks) != 0) return 0;
  g_gbst = (int64_t)b;
  for (int i = 0; i < 256; i++) g_gkeys[i] = ks[i] ? 1.0 : 0.0;
  return 1;
}

/* `(gfxdef …)` 登记进来的那几份串（着色器原文与名字表）。它们**在设备开起来之前**就来了
   （产物开头那一摊登记语句），所以先存下来，GL 那一档挂上之后再一趟补给插件。 */
#define GFX_MAXDEF 128
static struct { char *kind, *name, *text; } g_gdefs[GFX_MAXDEF];
static int g_ngdefs;

/* **名字表**（下标 -> 串）：文件纹理那一档要按下标还原成文件名，再按脚本所在的目录
   （`OMNI_GFX_DIR`）拼成路径 —— 与 `host/gfx-cpu.js` 的 `texPath` 逐句相同。 */
#define GFX_MAXNAME 256
static char *g_gnames[GFX_MAXNAME];

/* 文件纹理那一格的路径（回一格静态缓冲；下标不认识回 NULL）。 */
static const char *gfx_tex_path(int idx) {
  static char out[1024];
  if (idx < 0 || idx >= GFX_MAXNAME || g_gnames[idx] == NULL) return NULL;
  const char *nm = g_gnames[idx];
  const char *dir = getenv("OMNI_GFX_DIR");
  if (nm[0] == '/' || dir == NULL || dir[0] == 0) snprintf(out, sizeof(out), "%s", nm);
  else snprintf(out, sizeof(out), "%s/%s", dir, nm);
  /* 反斜杠（语料里有 `..\hei\brick_green.png` 这种）换成正斜杠。 */
  for (char *p = out; *p; p++) if (*p == '\\') *p = '/';
  return out;
}


static unsigned char *g_glpx = NULL;  /* 读回那一格（w*h*4，RGBA） */
static int64_t *g_gout = NULL;        /* 合成出来的那一帧（0xRRGGBB，喂 omni_gfx_emit） */

/* 想不想要 GL 那一档（`OMNI_GFX=gl`）。 */
static int gfx_gl_want(void) {
  static int w = -1;
  if (w < 0) {
    const char *m = getenv("OMNI_GFX");
    w = (m != NULL && strcmp(m, "gl") == 0) ? 1 : 0;
  }
  return w;
}

/* 挂上那份插件（尺寸已经定了才能开 —— 所以这一格由 `gfx_need` 叫）。回 1 = GL 这一档活着。 */
static int gfx_gl_need(void) {
  if (g_gl.tried) return g_gl.on;
  g_gl.tried = 1;
  if (!gfx_gl_want()) return 0;
  const char *cands[3];
  int nc = 0;
  const char *e = getenv("OMNI_GL_LIB");
  if (e != NULL && e[0] != '\0') cands[nc++] = e;
  cands[nc++] = ".omni-cache/gl/libomnigl.dylib";
  cands[nc++] = ".omni-cache/gl/libomnigl.so";
  for (int i = 0; i < nc; i++) {
    void *h = dlopen(cands[i], GFX_RTLD_NOW);
    if (h == NULL) continue;
    g_gl.open = (gfx_gl_open_fn)dlsym(h, "omni_ev_gl_open");
    g_gl.cls = (gfx_gl_cls_fn)dlsym(h, "omni_ev_gl_cls");
    g_gl.depth = (gfx_gl_depth_fn)dlsym(h, "omni_ev_gl_depth");
    g_gl.cull = (gfx_gl_int_fn)dlsym(h, "omni_ev_gl_cull");
    g_gl.batch = (gfx_gl_batch_fn)dlsym(h, "omni_ev_gl_batch");
    g_gl.read = (gfx_gl_read_fn)dlsym(h, "omni_ev_gl_read");
    g_gl.err = (gfx_gl_err_fn)dlsym(h, "omni_ev_gl_error");
    g_gl.def = (gfx_gl_def_fn)dlsym(h, "omni_ev_gl_def");
    g_gl.shader = (gfx_gl_shader_fn)dlsym(h, "omni_ev_gl_shader");
    g_gl.uniloc = (gfx_gl_loc_fn)dlsym(h, "omni_ev_gl_uniloc");
    g_gl.attrloc = (gfx_gl_loc_fn)dlsym(h, "omni_ev_gl_attrloc");
    g_gl.uni = (gfx_gl_uni_fn)dlsym(h, "omni_ev_gl_uni");
    g_gl.uni1i = (gfx_gl_uni1i_fn)dlsym(h, "omni_ev_gl_uni1i");
    g_gl.attr = (gfx_gl_attr_fn)dlsym(h, "omni_ev_gl_attr");
    g_gl.prog = (gfx_gl_int_fn)dlsym(h, "omni_ev_gl_prog");
    g_gl.blend = (gfx_gl_int_fn)dlsym(h, "omni_ev_gl_blend");
    g_gl.bindtex = (gfx_gl_int_fn)dlsym(h, "omni_ev_gl_bindtex");
    g_gl.activetex = (gfx_gl_int_fn)dlsym(h, "omni_ev_gl_activetex");
    g_gl.mvp = (gfx_gl_mvp_fn)dlsym(h, "omni_ev_gl_mvp");
    g_gl.mv = (gfx_gl_mvp_fn)dlsym(h, "omni_ev_gl_mv");
    g_gl.tex = (gfx_gl_tex_fn)dlsym(h, "omni_ev_gl_tex");
    g_gl.texfile = (gfx_gl_texfile_fn)dlsym(h, "omni_ev_gl_texfile");
    g_gl.univ = (gfx_gl_univ_fn)dlsym(h, "omni_ev_gl_univ");
    g_gl.gettex = (gfx_gl_gettex_fn)dlsym(h, "omni_ev_gl_gettex");
    g_gl.capbegin = (gfx_gl_cap_fn)dlsym(h, "omni_ev_gl_capbegin");
    g_gl.capend = (gfx_gl_cap_fn)dlsym(h, "omni_ev_gl_capend");
    g_gl.win = (gfx_gl_win_fn)dlsym(h, "omni_ev_gl_win");
    g_gl.winpresent = (gfx_gl_winpresent_fn)dlsym(h, "omni_ev_gl_win_present");
    g_gl.wininput = (gfx_gl_wininput_fn)dlsym(h, "omni_ev_gl_win_input");
    g_gl.wintitle = (gfx_gl_wintitle_fn)dlsym(h, "omni_ev_gl_win_title");
    if (g_gl.open == NULL || g_gl.batch == NULL || g_gl.read == NULL) continue;
    /* **`--mode view`：先试窗口**，开不出来（没装 GLFW / 不在主线程 / 没显示）
       就退回离屏那一半 —— 画面照样出得来，只是没有窗口。 */
    if (gfx_mode() == 2 && g_gl.win != NULL && g_gl.winpresent != NULL) {
      const char *ti = getenv("OMNI_GFX_TITLE");
      if (g_gl.win((int)g_gw, (int)g_gh, ti != NULL && ti[0] != '\0' ? ti : "omni") == 0) {
        g_glwin = 1;
        g_glwin_was = 1;
        /* 开成了印一行 —— 判据靠它认"这一趟真有窗口"（与下面那两行"挂不上/开不出来"
           同一档口径：**stderr 上一句话说清这一趟走的是哪条路**）。 */
        fprintf(stderr, "#gfx view 窗口 %lldx%lld\n", (long long)g_gw, (long long)g_gh);
      } else {
        fprintf(stderr, "#gfx view 开不出窗口（%s）—— 这一趟走离屏\n",
                g_gl.err != NULL ? g_gl.err() : "没话");
      }
    }
    if (!g_glwin && g_gl.open((int)g_gw, (int)g_gh) != 0) {
      fprintf(stderr, "#gfx gl 开不出来（%s）—— 这一趟走 CPU 备选\n",
              g_gl.err != NULL ? g_gl.err() : "没话");
      return 0;
    }
    g_glpx = (unsigned char *)malloc((size_t)(g_gw * g_gh * 4));
    g_gout = (int64_t *)malloc(sizeof(int64_t) * (size_t)(g_gw * g_gh));
    if (g_glpx == NULL || g_gout == NULL) return 0;
    g_gl.on = 1;
    /* 设备开起来之前登记的那几份串（着色器原文与名字表）一趟补过去。 */
    if (g_gl.def != NULL) {
      for (int k = 0; k < g_ngdefs; k++) {
        g_gl.def(g_gdefs[k].kind, g_gdefs[k].name, g_gdefs[k].text);
      }
    }
    return 1;
  }
  fprintf(stderr, "#gfx gl 挂不上 libomnigl（OMNI_GL_LIB 没指到那份库）"
                  "—— 这一趟走 CPU 备选\n");
  return 0;
}

/* GL 开着时：宿主那格帧缓冲清成"没人画"（-1），GPU 那一层自己清。 */
static void gfx_gl_clear_host(void) {
  for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = -1;
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
  /* GL 那一档（`OMNI_GFX=gl`）：尺寸定下来了才开得出离屏那一格。挂不上就照旧 CPU 备选。 */
  if (gfx_gl_need()) gfx_gl_clear_host();
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

/* 填充圆：逐行算半弦长，一行一段。
 *
 * **两层循环都夹到画布里**（2026-09-26）：三维那一档投影出来的半径在 z 接近近平面时会炸到
 * 上百万，不夹的话这儿要转 r*r 趟 —— conetest.kc 就是这么超时的。夹完画出来的像素一个不差：
 * 圆心先取整（对整数 x，gfx_rnd(cx)+x 与 gfx_rnd(cx+x) 相等），画布外那些格本来就被
 * gfx_px 丢掉。回 1 表示这一格圆把整块画布盖满了（gfx_cone 靠它停下来）。 */
static int gfx_disc (double cx, double cy, double r, int64_t c) {
  int64_t ri, cxi, cyi, dy0, dy1, mx, my;
  /* 半径先夹到 2^30：再大也只是"盖满画布"，但 ri*ri 得留在 int64 里。 */
  if (!(r >= 0.0)) return 0;
  ri = (r > 1073741824.0) ? 1073741824 : gfx_rnd(r);
  if (!(cx > -1e15 && cx < 1e15 && cy > -1e15 && cy < 1e15)) return 0;
  cxi = gfx_rnd(cx); cyi = gfx_rnd(cy);
  if (cxi + ri < 0 || cyi + ri < 0 || cxi - ri >= g_gw || cyi - ri >= g_gh) return 0;
  dy0 = (-ri > -cyi) ? -ri : -cyi;
  dy1 = (ri < g_gh - 1 - cyi) ? ri : g_gh - 1 - cyi;
  for (int64_t dy = dy0; dy <= dy1; dy++) {
    int64_t dx = (int64_t)floor(sqrt((double)(ri * ri - dy * dy)));
    int64_t x0 = (-dx > -cxi) ? -dx : -cxi;
    int64_t x1 = (dx < g_gw - 1 - cxi) ? dx : g_gw - 1 - cxi;
    for (int64_t x = x0; x <= x1; x++) gfx_px((double)(cxi + x), (double)(cyi + dy), c);
  }
  /* 盖满的判据是到画布最远那个角的距离 <= ri：那样每一行的 floor(sqrt(ri*ri-dy*dy)) 都
     >= 该行要的半弦长，所以这是准的，不是估的。 */
  mx = (cxi > g_gw - 1 - cxi) ? cxi : g_gw - 1 - cxi;
  my = (cyi > g_gh - 1 - cyi) ? cyi : g_gh - 1 - cyi;
  return (ri * ri >= mx * mx + my * my) ? 1 : 0;
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
 * 纹理坐标 s,t,p,q（这一档还没有纹理，收下不用）、法向 nx,ny,nz,0（同样收下不用）。
 * 类：0 = 线段（两个一组）、1 = 三角（三个一组）。
 */
#define GFX_VSTRIDE 16

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

/* **`OMNI_GFX_TRACE=n`：把前 n 段批的顶点印到 stderr** —— 与 `host/gfx-cpu.js` 的
   `traceV` 逐句相同，也与参考那侧的 `PD_TRACE` 同一个用途：对账要比的是**裁剪坐标**，
   不是像素（像素差只说明"哪儿不一样"，裁剪坐标说明"谁算错了"）。
   一行一个顶点：`#trace 类 批号 顶点号 x y z w r g b a`。 */
static long g_gtraced = 0;
static void gfx_tracev(int64_t kind, int64_t n, const double *v) {
  const char *e = getenv("OMNI_GFX_TRACE");
  long lim = (e == NULL || *e == 0) ? 0 : strtol(e, NULL, 10);
  if (g_gtraced >= lim) return;
  long id = g_gtraced++;
  for (int64_t i = 0; i < n; i++) {
    const double *p = v + i * GFX_VSTRIDE;
    fprintf(stderr, "#trace %lld %ld %lld %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g\n",
            (long long)kind, id, (long long)i, p[0], p[1], p[2], p[3],
            p[4], p[5], p[6], p[7]);
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
  gfx_tracev(kind, n, v);
  /* GL 那一档：一段批直接上传 + 一次 draw（软件光栅化那一摊一格都不走）。 */
  if (g_gl.on) {
    g_gl.batch((int)kind, (long)n, v);
    g_gdirty = 1;
    return (double)n;
  }
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
  if (gfx_gl_want()) gfx_need();   /* GL 那一档：真上传要设备已经开着 */
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
  /* GL 那一档：真上传（`glTexImage2D`）。这一层仍记下形状 —— 报错的话里要用。 */
  if (g_gl.on && g_gl.tex != NULL) {
    if (g_gl.tex((int)slot, (int)w, (int)h, (int)d, (int)fmt, px->items) != 0) {
      omni_errorf("本机 OpenGL：%s", g_gl.err != NULL ? g_gl.err() : "gfxtex 不成");
    }
  }
  g_gtex[slot].w = w;
  g_gtex[slot].h = h;
  g_gtex[slot].d = d;
  g_gtex[slot].fmt = fmt;
  g_gtex[slot].n = want;
  return 0.0;
}

/* ── **名字那一格按指针记账**（2026-09-25 量的）：生成的代码每趟递进来的是同一个字符串
 * **字面量**（`omni_gfx_call(omni_str_new("vertex", 6), …)`），所以（指针, 长度）这一对
 * 就是名字的身份。先前每一趟都先过一次 `omni_cstr`——在 arena 上抄一份带 NUL 的副本。
 * `disco ball` 一帧 3.6 万次图形调用，那份 memcpy 在 `--gfx null` 上占到 **21.6%** 的
 * 栈顶样本（`omni_gfx_call;_platform_memmove`）；`(gfxarr …)` 那条路也一样
 * （矩阵改成一句之后它是每段批两次 —— 8.7%）。
 *
 * 现在按指针直接映射到一份**记住的**副本：命中就不抄、不分配。`isq`（录制那一档要问的
 * "这格是不是查询"）一起记着，那也是每趟一串 strcmp。
 *
 * 为什么敢按指针认：字面量在 .rodata 上，地址与长度都不动。万一哪天递进来的是算出来的
 * 名字（指针会变），未命中那一路照旧抄一份 —— 答案一模一样，只是不省事。
 * 槽是直接映射的，撞了就重抄一份（名字总共一百来个，撞不起来）。 */
#define GFX_NCACHE 128
static struct { const char *p; int64_t len; char *cs; int isq; } g_gfxnc[GFX_NCACHE];

static char *gfx_name(omni_str s, int *isq) {
  uintptr_t u = (uintptr_t)s.p;
  size_t h = (size_t)(((u >> 4) ^ (u >> 2) ^ (uintptr_t)s.len) & (GFX_NCACHE - 1));
  if (g_gfxnc[h].p == s.p && g_gfxnc[h].len == s.len) {
    *isq = g_gfxnc[h].isq;
    return g_gfxnc[h].cs;
  }
  char *cs = omni_cstr(s);
  g_gfxnc[h].p = s.p;
  g_gfxnc[h].len = s.len;
  g_gfxnc[h].cs = cs;
  g_gfxnc[h].isq = gfx_is_query(cs);
  *isq = g_gfxnc[h].isq;
  return cs;
}

/**
 * `(gfxarr "名字" a0 a1 a2 a3 数组)`：**带一整块数组的宿主调用**（§19.1）。
 *
 * 认两族（`polydraw.c:2070` 那张表里带 `&` 的那几个，语料里用到的就这些）：
 *   * `gluniform{1,2,3,4}{f,i}v(句柄, 个数, &数组)` -> `(… 句柄 个数 0 0 数组)`
 *   * `glgettex(槽, &数组, 宽, 高, 分量)`           -> `(… 槽 宽 高 分量 数组)`（**往里写**）
 *
 * CPU 备选那一档**收下不管** —— 与纹理那一族同一句话（这一层是平面帧缓冲，
 * 没有可编程管线；真去 `glsetshader` 那一格才报）。
 */
double omni_gfx_arr(omni_str name, double a0, double a1, double a2, double a3,
                    struct omni_arr_f64_s *blk) {
  /* 录制那一档：这一族一格都不画（连名字都不用认）。 */
  if (gfx_rec()) { g_greccnt += 1; return 0.0; }
  int nm_isq = 0;
  const char *nm = gfx_name(name, &nm_isq);
  (void)nm_isq;
  if (gfx_gl_want()) gfx_need();
  long n = blk == NULL ? 0 : (long)blk->len;
  double *items = blk == NULL ? NULL : blk->items;
  /* **一整张矩阵一句**（`batchmvp16` / `batchmv16`，列主序 16 个数）：与四句
     `batchmvp`/`batchmv` **逐字等价**，只是少 7 句宿主调用（理由见
     `ext/polydraw/gl-rt.js` 里那段话）。不够 16 格就当没发。 */
  if (strcmp(nm, "batchmvp16") == 0 || strcmp(nm, "batchmv16") == 0) {
    gfx_gl_mvp_fn put = nm[7] == 'p' ? g_gl.mvp : g_gl.mv;
    if (!g_gl.on || put == NULL || n < 16) return 0.0;
    for (int c = 0; c < 4; c++) {
      put(c, items[c * 4], items[c * 4 + 1], items[c * 4 + 2], items[c * 4 + 3]);
    }
    return 0.0;
  }
  /* `gluniform<N><f|i>v`：名字里第 10 个字符是分量数、第 11 个是 f/i。 */
  if (strncmp(nm, "gluniform", 9) == 0 && nm[9] >= '1' && nm[9] <= '4'
      && (nm[10] == 'f' || nm[10] == 'i') && nm[11] == 'v') {
    if (!g_gl.on || g_gl.univ == NULL) return 0.0;
    long cnt = (long)a1;
    if (cnt < 0) cnt = 0;
    if (cnt * (nm[9] - '0') > n) cnt = n / (nm[9] - '0');
    return (double)g_gl.univ(a0, nm[9] - '0', nm[10] == 'i' ? 1 : 0, cnt, items);
  }
  /* `glgettex(槽, &数组, 宽, 高, 格)`：**写回几格由设备说**（一像素几个 double 只有
     它知道 —— 那一槽自己的格，见 `omni_ev_gl_gettex` 的头注）。这一层只把数组长度
     当上限递过去；设备回 -1 就是"没读到"，与原版一样。 */
  if (strcmp(nm, "glgettex") == 0) {
    if (!g_gl.on || g_gl.gettex == NULL) return 0.0;
    int got = g_gl.gettex((int)a0, (int)a1, (int)a2, n, items);
    return got < 0 ? -1.0 : 0.0;
  }
  /**
   * **整行像素**（`setrow y x0 数 0 行`，2D graphing modes 那一族）：一行一次宿主调用 ——
   * 320×240 那是 240 次，不是 76800 次（`ext/polydraw/graph-rt.js` 的头注）。
   * 一格一个打包好的 0xRRGGBB，写的是**宿主那一层**（GL 那一档里它盖在 GPU 那层上头）。
   * 与 `host/gfx-cpu.js` 的 `gfxArr` 逐句相同。
   */
  if (strcmp(nm, "setrow") == 0) {
    gfx_need();
    int64_t y = (int64_t)a0;
    if (y < 0 || y >= g_gh) return 0.0;
    int64_t x0 = (int64_t)a1;
    int64_t cnt = (int64_t)a2;
    if (cnt > n) cnt = n;
    for (int64_t i = 0; i < cnt; i++) {
      int64_t x = x0 + i;
      if (x < 0 || x >= g_gw) continue;
      g_gfb[y * g_gw + x] = ((int64_t)items[i]) & 0xffffff;
    }
    g_gdirty = 1;
    return 0.0;
  }
  /* 别的名字：这一层不认 —— 与 `(gfxcall …)` 那条路同一句话，说清这一档有的是哪几族。 */
  omni_errorf("gfxarr: 不认识 '%s'（有的是 setrow / gluniform{1..4}{f,i}v / glgettex）", nm);

  return 0.0;
}

/* 一条轴上可见 t 区间的界（lo <= p0 + t*d <= hi）：`hi_side` 为 0 取下界、1 取上界。
   d == 0 那一档要么整条都在（0..1）、要么整条都不在（回 2 / -1 配成空区间）。 */
static double gfx_taxis (double p0, double d, double lo, double hi, int hi_side) {
  if (d == 0.0) {
    if (p0 < lo || p0 > hi) return hi_side ? -1.0 : 2.0;
    return hi_side ? 1.0 : 0.0;
  }
  if (d > 0.0) return hi_side ? (hi - p0) / d : (lo - p0) / d;
  return hi_side ? (lo - p0) / d : (hi - p0) / d;
}

/* drawcone(x,y,r,x2,y2,r2) 是粗线：沿线铺圆。
 *
 * **两处夹**（2026-09-26，与 gfx_disc 那一刀同源）：n 是屏幕空间长度，三维投影一炸它也炸。
 * 一、i 只走沾画布的那一段（线段按 ±(rmax+2) 的余量夹一趟，扔掉的那些圆一个像素都画不出来）；
 * 二、某一格圆一旦盖满画布就停 —— 整条 cone 同一个颜色 c，后面那些圆只会把同样的颜色写回
 * 同一片格子，出图逐字节相同。 */
static void gfx_cone (double x0, double y0, double r0, double x1, double y1, double r1, int64_t c) {
  double dx = x1 - x0, dy = y1 - y0;
  double len = sqrt(dx * dx + dy * dy) + 1.0;
  double mg, tlo, thi, a, b;
  int64_t n, i, ie;
  if (!(len >= 1.0) || len > 1e15) return;
  n = (int64_t)floor(len);
  mg = ((r0 > r1) ? r0 : r1);
  if (!(mg > 0.0)) mg = 0.0;
  mg += 2.0;
  tlo = 0.0; thi = 1.0;
  a = gfx_taxis(x0, dx, -mg, (double)(g_gw - 1) + mg, 0);
  b = gfx_taxis(y0, dy, -mg, (double)(g_gh - 1) + mg, 0);
  if (a > tlo) tlo = a;
  if (b > tlo) tlo = b;
  a = gfx_taxis(x0, dx, -mg, (double)(g_gw - 1) + mg, 1);
  b = gfx_taxis(y0, dy, -mg, (double)(g_gh - 1) + mg, 1);
  if (a < thi) thi = a;
  if (b < thi) thi = b;
  if (!(thi >= tlo)) return;
  i = (int64_t)ceil(tlo * (double)n);
  ie = (int64_t)floor(thi * (double)n);
  if (ie > n) ie = n;
  for (; i <= ie; i++) {
    double t = (double)i / (double)n;
    if (gfx_disc(x0 + t * dx, y0 + t * dy, r0 + t * (r1 - r0), c)) return;
  }
}

/* `refresh()`：交出这一帧 —— 写表面文件 + stdout 上印一行指针（与 JS 那一侧一字不差）。 */
static void gfx_present(void) {
  if (!g_gon) return;
  /* **窗口那一档**（`--mode view`）：贴到窗口上就是"交帧"。合成那一步与下面离屏那一档
     **同一句话**（GPU 那层当底、宿主那层盖上去）—— 所以 view 与 render 两档的画面
     逐字节相同，判据可以直接比。`OMNI_GFX_OUT` 给了的话顺带把这一帧也写出去
     （只留最后一帧），那是判据要的那个口子。 */
  if (g_glwin) {
    int64_t *fb = g_gfb;
    if (g_gl.read(g_glpx) == 0) {
      for (int64_t i = 0; i < g_gw * g_gh; i++) {
        if (g_gfb[i] >= 0) { g_gout[i] = g_gfb[i]; continue; }
        const unsigned char *q = g_glpx + i * 4;
        g_gout[i] = ((int64_t)q[0] << 16) | ((int64_t)q[1] << 8) | (int64_t)q[2];
      }
      fb = g_gout;
      /* 贴上去那一张按合成后的结果重填（宿主那一层盖过的格子要跟着变）。 */
      for (int64_t i = 0; i < g_gw * g_gh; i++) {
        unsigned char *q = g_glpx + i * 4;
        q[0] = (unsigned char)((g_gout[i] >> 16) & 255);
        q[1] = (unsigned char)((g_gout[i] >> 8) & 255);
        q[2] = (unsigned char)(g_gout[i] & 255);
        q[3] = 255;
      }
    }
    if (g_gl.winpresent(g_glpx) == 0) g_glwin = 0;   /* 窗口关了 */
    const char *vp = getenv("OMNI_GFX_OUT");
    if (vp != NULL && vp[0] != '\0') {
      omni_gfx_emit(omni_str_new(vp, (int64_t)strlen(vp)), g_gw, g_gh, NULL, fb);
    }
    /* 标题上写 fps（一秒一次）—— 与 polydraw-view 那一手同一格，顺带当"帧在推进"的证据。 */
    if (g_gl.wintitle != NULL) {
      static double t0 = -1;
      static long nf = 0;
      double now = gfx_now_ms();
      nf++;
      if (t0 < 0) t0 = now;
      if (now - t0 >= 1000.0) {
        char buf[256];
        const char *ti = getenv("OMNI_GFX_TITLE");
        snprintf(buf, sizeof(buf), "%s — %.1f fps",
                 ti != NULL && ti[0] != '\0' ? ti : "omni",
                 (double)nf * 1000.0 / (now - t0));
        g_gl.wintitle(buf);
        t0 = now;
        nf = 0;
      }
    }
    g_gdirty = 0;
    return;
  }
  const char *p = getenv("OMNI_GFX_OUT");
  /* 没明说落点就用 CLI 摆的**默认**（`<缓存根>/gfx/<脚本名>.png`，见 cli.js 的
     `setGfxDefaultOut`）；连那格都没有（独立产物，没人知道脚本叫什么）才走最后这句。 */
  if (p == NULL || p[0] == '\0') p = getenv("OMNI_GFX_OUT_DEFAULT");
  if (p == NULL || p[0] == '\0') p = ".omni-cache/gfx/frame.png";

  int64_t *fb = g_gfb;
  /* GL 那一档：把 GPU 那一层读回来当底，宿主那一层（-1 = 没人画）盖上去。
     一帧只读一次（`_read` 里是 `glFinish` + `glReadPixels`，同步的）。 */
  if (g_gl.on && g_gl.read(g_glpx) == 0) {
    for (int64_t i = 0; i < g_gw * g_gh; i++) {
      if (g_gfb[i] >= 0) { g_gout[i] = g_gfb[i]; continue; }
      const unsigned char *q = g_glpx + i * 4;
      g_gout[i] = ((int64_t)q[0] << 16) | ((int64_t)q[1] << 8) | (int64_t)q[2];
    }
    fb = g_gout;
  }
  omni_gfx_emit(omni_str_new(p, (int64_t)strlen(p)), g_gw, g_gh, NULL, fb);
  /* 指针那一行把种类带上（默认 png、`.rgba` 是备选）—— 与 host/gfx-cpu.js 一字不差。 */
  size_t pl = strlen(p);
  const char *kind = (pl >= 5 && strcmp(p + pl - 5, ".rgba") == 0) ? "rgba" : "png";
  printf("#gfx %s %s %lld %lld\n", kind, p, (long long)g_gw, (long long)g_gh);
  g_gdirty = 0;
}

/* 帧循环那几格旗子读一次（与 host/gfx-cpu.js 的 frameSetup 一字不差）。 */
static void gfx_frame_setup(void) {
  g_gonly = gfx_int_env("OMNI_GFX_FRAME", -1);
  /* `klock()` 的零点摆在这儿 —— 正本是"编译那一刻"，这儿是"第一帧之前"（见 `g_gkt0`）。 */
  g_gkt0 = gfx_now_ms();

  int64_t n = g_gonly >= 0 ? g_gonly + 1 : gfx_int_env("OMNI_FRAMES", 1);
  /* **窗口那一档**：默认**没有上限** —— 收摊的是"窗口关了"，不是帧数。
     `OMNI_FRAMES=N` 仍然管用（判据要一个能自己停下来的口子）。 */
  if (g_glwin && getenv("OMNI_FRAMES") == NULL && g_gonly < 0) n = (int64_t)1 << 62;
  g_gframes = n > 0 ? n : 1;
  const char *p = getenv("OMNI_GFX_PERF");
  g_gperf = (p != NULL && strcmp(p, "1") == 0) ? 1 : 0;
  /* 暖态从第几帧算起（缺省跳 1 帧）。只有一帧时不跳 —— 不然一个数都报不出来。 */
  g_gskip = gfx_int_env("OMNI_GFX_PERF_SKIP", 1);
  if (g_gskip < 0) g_gskip = 0;
  if (g_gskip >= g_gframes) g_gskip = g_gframes > 1 ? g_gframes - 1 : 0;
}

/* 一帧末：记一笔时间，再看这一帧要不要交出去。 */
static void gfx_frame_end(void) {
  double dt = gfx_now_ms() - g_gtprev;
  g_gtsum += dt;
  g_gtn += 1;
  if (g_gtn == 1 || dt < g_gtmin) g_gtmin = dt;
  if (dt > g_gtmax) g_gtmax = dt;
  if (g_gtn > g_gskip) {
    g_gwsum += dt;
    g_gwn += 1;
    if (g_gwn == 1 || dt < g_gwmin) g_gwmin = dt;
    if (dt > g_gwmax) g_gwmax = dt;
  }
  /* **点着名要的那一帧一定交**（`--frame N`）—— 与 `host/gfx-cpu.js` 的 `frameEnd`
     逐句相同：一个像素都没画的脚本给出的是一张清过的图，不是"没有图"。 */
  if (g_gonly >= 0 && g_gfno - 1 == g_gonly) { gfx_need(); gfx_present(); return; }
  /* 窗口那一档：**每帧都交**（不看 dirty）—— 真实时循环，这一格就是 swap + poll。 */
  if (g_glwin) { gfx_present(); return; }
  if (g_gdirty && g_gonly < 0) gfx_present();
}

/* 这一趟的性能账（--perf / OMNI_GFX_PERF=1 才印，落 stderr）——
   一位小数，与 host/gfx-cpu.js 的 perfReport 同一个格式。 */
static void gfx_perf_report(void) {
  if (g_gperf != 1 || g_gtn == 0) return;
  g_gperf = 2;
  /* 暖态那一段一个数都没有（帧数 ≤ skip）时退回全部 —— 报个数比报空的有用。 */
  int64_t n = g_gwn > 0 ? g_gwn : g_gtn;
  double sum = g_gwn > 0 ? g_gwsum : g_gtsum;
  double lo = g_gwn > 0 ? g_gwmin : g_gtmin;
  double hi = g_gwn > 0 ? g_gwmax : g_gtmax;
  double avg = sum / (double)n;
  fprintf(stderr, "#perf gfx %s frames=%lld total=%.1fms avg=%.1fms min=%.1fms max=%.1fms fps=%.1f"
          " warm=%lld warmtotal=%.1fms\n",
          gfx_mode() == 2 ? "view" : "render", (long long)g_gtn,
          g_gtsum, avg, lo, hi, avg > 0.0 ? 1000.0 / avg : 0.0,
          (long long)n, sum);
  if (gfx_rec()) fprintf(stderr, "#perf calls total=%lld\n", (long long)g_greccnt);
}

double omni_gfx_call(omni_str name, int64_t argc, double a0, double a1, double a2,
                     double a3, double a4, double a5, double a6, double a7, double a8,
                     double a9, double a10, double a11) {
  int nm_isq = 0;
  char *nm = gfx_name(name, &nm_isq);
  (void)a6; (void)a7; (void)a8; (void)a9; (void)a10; (void)a11;
  /* 录制那一档：记一笔，画图那一族到此为止（查询与帧循环照旧往下走）。 */
  if (gfx_rec()) {
    g_greccnt += 1;
    if (!nm_isq) return 0.0;
  }
  if (!strcmp(nm, "cls") && argc == 3) {
    gfx_need();
    int64_t c = gfx_rgb(a0, a1, a2);
    if (g_gl.on) { g_gl.cls((unsigned int)c); gfx_gl_clear_host(); g_gdirty = 1; return 0.0; }
    for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = c;
    return 0.0;
  }
  /* `cls(打包好的颜色)`：EvalDraw 里最常见的写法（`cls(0)`）—— 与 setcol/1 同一档。 */
  if (!strcmp(nm, "cls") && argc == 1) {
    gfx_need();
    int64_t c = ((int64_t)a0) & 0xffffff;
    if (g_gl.on) { g_gl.cls((unsigned int)c); gfx_gl_clear_host(); g_gdirty = 1; return 0.0; }
    for (int64_t i = 0; i < g_gw * g_gh; i++) g_gfb[i] = c;
    return 0.0;
  }
  /* ── **可编程管线与纹理那一族**：GL 那一档转给插件，别的档照旧往下走（收下不用/报）。
     句柄那两格（uniform / attrib）回的是插件给的数，脚本原样拿着再递回来。
     这几格可能是这一趟的**第一句**图形调用（`glsetshader` 在清屏之前），所以先把设备开起来。 */
  if (gfx_gl_want()) gfx_need();
  if (g_gl.on) {
    if (!strcmp(nm, "glsetshader") && argc >= 1 && argc <= 3 && g_gl.shader != NULL) {
      double av[3] = { a0, a1, a2 };
      if (g_gl.shader((int)argc, av) != 0) {
        omni_errorf("本机 OpenGL：%s", g_gl.err != NULL ? g_gl.err() : "glsetshader 不成");
      }
      return 0.0;
    }
    if (!strcmp(nm, "glgetuniformloc") && argc == 1 && g_gl.uniloc != NULL) {
      return g_gl.uniloc(a0);
    }
    if (!strcmp(nm, "glgetattribloc") && argc == 1 && g_gl.attrloc != NULL) {
      return g_gl.attrloc(a0);
    }
    if (g_gl.uni != NULL && argc >= 2 && argc <= 5
        && (!strcmp(nm, "gluniform1f") || !strcmp(nm, "gluniform2f")
            || !strcmp(nm, "gluniform3f") || !strcmp(nm, "gluniform4f")
            || !strcmp(nm, "gluniform"))) {
      double v[4] = { a1, a2, a3, a4 };
      return (double)g_gl.uni(a0, (int)argc - 1, v);
    }
    if (g_gl.attr != NULL && argc >= 2 && argc <= 5
        && (!strcmp(nm, "glvertexattrib1f") || !strcmp(nm, "glvertexattrib2f")
            || !strcmp(nm, "glvertexattrib3f") || !strcmp(nm, "glvertexattrib4f"))) {
      /* 少给的那几格照 GL 的默认补（x,y,z 是 0、w 是 1）。 */
      double v[4] = { a1, argc >= 3 ? a2 : 0.0, argc >= 4 ? a3 : 0.0, argc >= 5 ? a4 : 1.0 };
      return (double)g_gl.attr(a0, v);
    }
    /* `gluniform1i(句柄, 整数)`：整数那一档（采样器与开关位走它）。 */
    if (!strcmp(nm, "gluniform1i") && argc == 2 && g_gl.uni1i != NULL) {
      return (double)g_gl.uni1i(a0, a1);
    }
    if (!strcmp(nm, "batchmvp") && argc == 5 && g_gl.mvp != NULL) {
      g_gl.mvp((int)a0, a1, a2, a3, a4);
      return 0.0;
    }
    if (!strcmp(nm, "batchmv") && argc == 5 && g_gl.mv != NULL) {
      g_gl.mv((int)a0, a1, a2, a3, a4);
      return 0.0;
    }
    if (!strcmp(nm, "batchblend") && argc == 1 && g_gl.blend != NULL) {
      g_gl.blend((int)a0);
      return 0.0;
    }
    if (!strcmp(nm, "glbindtexture") && argc == 1 && g_gl.bindtex != NULL) {
      g_gl.bindtex((int)a0);
      return 0.0;
    }
    /* **抓屏那一族**（§22）：`glcapture(边长)` 清底 + 换视口，`glcaptureend(槽)`
       一次 `glCopyTexImage2D` 拷进那一槽 —— 与 `host/gfx-cpu.js` 的 `glcapture/1`
       逐句相同（语言那一侧发的就是一参那两格）。 */
    if (!strcmp(nm, "glcapture") && argc == 1 && g_gl.capbegin != NULL) {
      return (double)g_gl.capbegin((int)a0);
    }
    if (!strcmp(nm, "glcaptureend") && argc == 1 && g_gl.capend != NULL) {
      return (double)g_gl.capend((int)a0);
    }
    /* **文件纹理**（`glsettexfile 槽 名字下标 colmode`，§20）：路径在这一层拼
       （目录只有宿主知道），解码与上传在设备 —— 与 `host/gfx-cpu.js` 那一格同一手。 */
    if (!strcmp(nm, "glsettexfile") && argc == 3 && g_gl.texfile != NULL) {
      const char *p = gfx_tex_path((int)a1);
      if (p == NULL) return 1.0;
      return (double)g_gl.texfile((int)a0, p, (int)a2);
    }
    if (!strcmp(nm, "glactivetexture") && argc == 1 && g_gl.activetex != NULL) {
      /* 实参是 `GL_TEXTURE0 + i`（0x84c0）或者直接是 i —— 两种写法都有。 */
      int u = (int)a0;
      g_gl.activetex(u >= 0x84c0 ? u - 0x84c0 : u);
      return 0.0;
    }
  }
  /* ── 收下但这一档做不到的那几格（与 `host/gfx-cpu.js` 逐句相同）──────────────
     `framebegin` 每帧初态：GL 的状态机在语言那一侧，设备这侧只把画布清掉；
     `clz`/`gldepth`：这一档没有 z 缓冲；剩下几格（点大小/剔除/alpha/垂直同步/线宽/sleep）
     在这一档没有意思，收下记着不用。 */
  if (!strcmp(nm, "framebegin") && argc == 0) {
    gfx_need();
    if (g_gl.on) { g_gl.cls(0); gfx_gl_clear_host(); g_gdirty = 1; return 0.0; }
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
  /* GL 挂不上那一趟（CPU 备选）：文件纹理收下不管 —— 与别的纹理那一族同一句话。 */
  if (!strcmp(nm, "glsettexfile") && argc == 3) { return 0.0; }
  if (!strcmp(nm, "glactivetexture") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glcapture") && argc == 0) { return 0.0; }
  /* 一参那两格是语言那一侧真发的（边长 / 槽）：GL 挂不上就收下不管（CPU 备选这一层
     没有纹理采样），照旧出图。 */
  if (!strcmp(nm, "glcapture") && argc == 1) { return 0.0; }
  if (!strcmp(nm, "glcapture") && argc == 4) { return 0.0; }
  if (!strcmp(nm, "glcaptureend") && argc <= 1) { return 0.0; }
  if (!strcmp(nm, "mountzip") && argc >= 1 && argc <= 2) { return 0.0; }
  if (!strcmp(nm, "glulookat") && argc == 9) { return 0.0; }
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
  /* `glklockstart` / `glklockelaps`：GPU 那一侧的计时（polydraw.c 的 GLKLOCK*）——
     收下：时间那一格由 klock 那一族统一给（与 host/gfx-cpu.js 同一句话）。 */
  if (!strcmp(nm, "glklockstart") && argc == 0) { return 0.0; }
  if (!strcmp(nm, "glklockelapsed") && argc == 0) { return 0.0; }
  if (!strcmp(nm, "gltextdisable") && argc == 0) { return 0.0; }
  /* `glprogramenvparam`：**ARB 汇编专用**（`polydraw.c:2111` 那一行写着 "for arb asm"）。
     core profile / WebGL 都没有 ARB 汇编，参考实现也是 no-op —— 收下不管（§19.2）。 */
  if (!strcmp(nm, "glprogramenvparam") && argc == 5) { return 0.0; }
  /* `glprogramlocalparam`：同上（`polydraw.c:2110`，走 `glProgramLocalParameter4fARB`）。 */
  if (!strcmp(nm, "glprogramlocalparam") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "sleep") && argc == 1) { return 0.0; }
  /* **深度测试**（语言那一侧的 `gl_enable(GL_DEPTH_TEST)` 转过来的）：这一档没有
     z 缓冲，收下记着不用 —— 与 `host/gfx-cpu.js` 那一份同一句话。 */
  if (!strcmp(nm, "gldepth") && argc == 1) {
    if (g_gl.on && g_gl.depth != NULL) g_gl.depth((int)a0 != 0 ? 1 : 0);
    return 0.0;
  }
  /* **面剔除**（语言那一侧的 `glcullface` 转过来的，0 关 / 1 剔背面 / 2 剔正面）：
     这一档没有真管线，收下不管 —— 与 `host/gfx-cpu.js` 那一份同一句话。 */
  if (!strcmp(nm, "glcull") && argc == 1) {
    if (g_gl.on && g_gl.cull != NULL) g_gl.cull((int)a0);
    return 0.0;
  }
  /* ── **批上带的那点状态**（第四刀，与 `host/gfx-cpu.js` 逐句相同）：这一档没有
     可编程管线，所以 `batchprog` 非零是当场报（不静默按内建那对画）；那张 `u_mvp`
     与混合开关在这一档没有落点，收下记着不用。 */
  if (!strcmp(nm, "batchprog") && argc == 1) {
    if (g_gl.on && g_gl.prog != NULL) { g_gl.prog((int)a0 != 0 ? 1 : 0); return 0.0; }
    if ((int64_t)a0 != 0) {
      if (g_gl.on) {
        omni_errorf("本机 OpenGL：挂上的那份 libomnigl 里没有可编程管线那几格符号"
                    "（omni_ev_gl_prog…）—— 库旧了，重编一趟");
      }
      omni_errorf("这格设备（CPU 备选）没有可编程管线 —— 脚本挑了自己那格 program"
                  "（glsetshader），顶点是物体坐标，这一档接不了；要 GPU 那两档设备"
                  "（浏览器 WebGL2 / 本机 OpenGL）");
    }
    return 0.0;
  }
  if (!strcmp(nm, "batchmvp") && argc == 5) { return 0.0; }
  if (!strcmp(nm, "batchmv") && argc == 5) { return 0.0; }
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
  if (!strcmp(nm, "refresh") && argc == 0) {
    gfx_need();
    /* **帧循环写在脚本里**那一族（EvalDraw 的 `()` 模式：`while(1){ …; refresh(); }`，
       语料里 21 份这么写）：设备这侧一次 `nextframe` 都收不到，于是从前这儿只是
       "交一帧"、脚本那个 `while(1)` 永远不回来 —— 扫描里那 21 份"超时"**全是这个，
       不是算得慢**（`demos/minsurf.kc` 量过：图出来了、然后一直转）。
       所以这儿要把一帧走完：结算 -> 预算用完就收摊 -> 帧号 +1。
       **收摊只能 `exit`**：脚本那个 `while(1)` 没有出口，这是唯一停得下来的地方。
       顺带治好两格：`numframes` 与 `klock` 从前在这一族上永远是 0（帧号没人加）。

       **怎么分清两种写法**：不能看"有没有人调过 `nextframe`" —— 产物的入口永远是
       `while (nextframe()) eval$frame();`，所以那一格永远是 1（踩过：这么判等于没判）。
       真正的分界是**一次 body 里调了几次 `refresh`**：
         * 标准写法（宿主每帧调一次 body）一次最多一回 —— 那一回照旧只"交图"；
         * 脚本自己 `while(1)` 那一族第二回就来了 —— 从第二回起才结算帧、查预算。
       于是标准那一族的行为一个字节都没变。 */
    g_grefr += 1;
    if (g_grefr < 2) { gfx_present(); return 0.0; }
    if (g_gframes < 0) { gfx_frame_setup(); g_gfno = 1; }
    gfx_frame_end();
    if ((g_glwin_was && g_glwin == 0) || g_gfno >= g_gframes) { gfx_perf_report(); exit(0); }
    g_gfno += 1;
    g_gkn = 0;                        /* 新一帧：klock 那个"帧内第几次"从头数 */
    g_gtprev = gfx_now_ms();
    return 0.0;
  }
  /* **帧循环那一格**（与 host/gfx-cpu.js 的 nextframe 一字不差）：产物自己 while 着问它
     "还画不画下一帧" —— 于是循环在设备里。这一档画 OMNI_FRAMES 帧（默认 1）。 */
  if (!strcmp(nm, "nextframe") && argc == 0) {
    gfx_need();
    g_grefr = 0;
    if (g_gframes < 0) gfx_frame_setup();
    if (g_gfno > 0) gfx_frame_end();
    /* 窗口那一档：窗口一关就收摊（`gfx_present` 里把 `g_glwin` 置了 0）。 */
    if (g_glwin_was && g_glwin == 0) {
      gfx_perf_report();
      return 0.0;
    }
    if (g_gfno >= g_gframes) { gfx_perf_report(); return 0.0; }
    g_gfno += 1;
    g_gkn = 0;                        /* 新一帧：klock 那个"帧内第几次"从头数 */
    g_gtprev = gfx_now_ms();
    return 1.0;
  }
  if (!strcmp(nm, "numframes") && argc == 0) { gfx_need(); return (double)(g_gfno > 0 ? g_gfno - 1 : 0); }
  /* `klock()`：秒。**render 模式下是确定性时钟**（帧号 / 60，照 c_impl 的 1/60 clock scale）
     —— 与 host/gfx-cpu.js 的 `klockSec()` 一字不差，所以三条腿仍然逐字节相同。
     view 模式才是墙上时间。**同一帧里第二次起往前走一帧的量**（见那边的头注：
     magpong2 那一族把帧限速写在脚本里，钉死的时钟让它出不来）。 */
  if (!strcmp(nm, "klock") && argc == 0) { return gfx_klock_sec(); }
  /* `klock(i)`：0 与 klock() 同；|i| 在 1..9 是日期分量（i>0 本地、i<0 UTC）——
     口径照 polydraw_src/polydraw.c:1662 的 myklock，与 host/gfx-cpu.js 的 klockParts 同。 */
  if (!strcmp(nm, "klock") && argc == 1) {
    int i = (int)a0;
    if (i == 0) { return gfx_klock_sec(); }
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
    int64_t c = g_gfb[gy * g_gw + gx];
    /* GL 那一档里 -1 是"这一格宿主没画"（GPU 那一层上的像素要等交帧才读回来）。
       读那一格回背景 0 —— 不为了一次 `getpix` 去 `glReadPixels` 一整帧。 */
    return c < 0 ? 0.0 : (double)c;
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

/* `(gfxdef 种类 名字 内容)`：往设备上登记一格有名字的串（着色器原文 / 名字表）。
   CPU 备选这一档用不上（可编程管线在那儿没有落点），但**本机 OpenGL 那一档要** ——
   而这几句在设备开起来之前就到了，所以先存下来，`gfx_gl_need` 挂上之后一趟补过去。
   存的是自己的一份拷贝：`omni_str` 那几格的寿命不由我们说。 */
double omni_gfx_def(omni_str kind, omni_str name, omni_str text) {
  /* 名字表在这一层也留一份（文件纹理要按下标还原成文件名，见 `gfx_tex_path`）。 */
  if (strcmp(omni_cstr(kind), "name") == 0) {
    int i = atoi(omni_cstr(name));
    if (i >= 0 && i < GFX_MAXNAME) {
      free(g_gnames[i]);
      g_gnames[i] = strdup(omni_cstr(text));
    }
  }
  if (g_gl.on && g_gl.def != NULL) {
    g_gl.def(omni_cstr(kind), omni_cstr(name), omni_cstr(text));
    return 0.0;
  }
  if (g_ngdefs >= GFX_MAXDEF) return 0.0;
  g_gdefs[g_ngdefs].kind = strdup(omni_cstr(kind));
  g_gdefs[g_ngdefs].name = strdup(omni_cstr(name));
  g_gdefs[g_ngdefs].text = strdup(omni_cstr(text));
  g_ngdefs++;
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

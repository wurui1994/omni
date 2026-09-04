/*
 * Omni — GLSL 快路的**运行宿主**（ADR-0019 决策八）
 *
 * 这一份是「复刻 llvmpipe」那条路上真正等效的那一格：**一个进程、不落盘、按指针调用**。
 *
 *   IR 从 stdin 进来（一段字节，不经过文件系统）
 *     -> LLJIT 在**本进程**里编译
 *     -> Lookup 拿到地址，强转成函数指针
 *     -> 光栅化框架**直接 call 它**，就在这个进程里
 *
 * 与 `omni_jit.c` 的分工：那一份是通用的「吃一份 `.ll`、调它的 `main`」，`tests/jit`
 * 那条轴钉的是它，别去改。这一份是**着色器专用**的宿主 —— 它认识 `glsl_frag8` 的 ABI，
 * 框架也在它自己身上。
 *
 * 为什么要有这一份（量出来的）：从前那条路是 node 出 `.ll` -> 写盘 -> spawn `omni-jit`
 * -> 那个进程里 JIT 出 `main` 再跑。「改一个开关到能出像素」量到 606 ms，其中光是
 * 「进程启动 + LLJIT 初始化」就 13 ms、node 那一侧 30 ms，而 llvmpipe 编一整个片元变体
 * 是 1～20 ms。差的那部分**全都不是编译**，是架构：用文件与进程当接口。这一份把接口
 * 换成一个函数指针。
 *
 * ABI（与 `emit_llvm.js` 的 `run()` 一字对齐）：
 *
 *   void glsl_frag8(const f8 *in, f8 *out)
 *     in  = [x, y, uniform 每一格…]，每格 8 道 f32
 *     out = [r, g, b, a, 覆盖度]（覆盖度：1.0 写回、0.0 被 discard 杀掉）
 *
 *   用法：
 *     omni-glsl-jit --samples RES        < frag.ll
 *     omni-glsl-jit --render W H OUT.png [uniform 每一格…]  < frag.ll
 *     omni-glsl-jit --bench SIZE REPS    < frag.ll
 *
 *   印出来的 `compile_ms` 是**只量 Lookup 那一句**：ORC 是惰性物化的，编译就发生在那儿。
 */

#include <llvm-c/Core.h>
#include <llvm-c/Error.h>
#include <llvm-c/IRReader.h>
#include <llvm-c/LLJIT.h>
#include <llvm-c/Orc.h>
#include <llvm-c/Target.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
/* 多线程渲一帧（行块队列）要这两个：pthread 与 `_SC_NPROCESSORS_ONLN`。 */
#include <pthread.h>
#include <unistd.h>

typedef float f8 __attribute__((ext_vector_type(8)));
typedef void (*frag8_fn)(const f8 *in, f8 *out);

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

static int fail_err(LLVMErrorRef e, const char *what) {
  char *m = LLVMGetErrorMessage(e);
  fprintf(stderr, "omni-glsl-jit: %s: %s\n", what, m);
  LLVMDisposeErrorMessage(m);
  return 70;
}

/* stdin 整个读进内存。**没有文件路径这回事** —— 这是这一份存在的理由之一。 */
static char *slurp_stdin(size_t *len) {
  size_t cap = 1 << 16;
  size_t n = 0;
  char *buf = (char *)malloc(cap);
  if (buf == NULL) return NULL;
  for (;;) {
    if (n + 4096 + 1 > cap) {
      cap *= 2;
      char *bigger = (char *)realloc(buf, cap);
      if (bigger == NULL) { free(buf); return NULL; }
      buf = bigger;
    }
    size_t got = fread(buf + n, 1, 4096, stdin);
    n += got;
    if (got < 4096) break;
  }
  buf[n] = 0;
  *len = n;
  return buf;
}

/* 与 `tests/glsl/fast.js` 里那一份**一字不差**的取样点。 */
static const float SX[8] = { 0.5f, 511.5f, 0.5f, 511.5f, 100.5f, 1023.5f, 37.5f, 700.5f };
static const float SY[8] = { 0.5f, 0.5f, 511.5f, 511.5f, 200.5f, 1023.5f, 900.5f, 13.5f };

static void samples(frag8_fn frag, float res) {
  f8 in[4], out[5];
  for (int l = 0; l < 8; l++) { in[0][l] = SX[l]; in[1][l] = SY[l]; }
  in[2] = (f8)res;
  in[3] = (f8)res;
  frag(in, out);
  for (int l = 0; l < 8; l++) {
    printf("%.9g %.9g %.9g %.9g\n", out[0][l], out[1][l], out[2][l], out[3][l]);
  }
}

/* 框架那一半与 `fast_driver.c` 同形（整条向量地生成 x、量化整批做），
   这样两条路的 MPix/s 是同一个口径。 */
static void bench(frag8_fn frag, int size, int reps) {
  const f8 lane = { 0, 1, 2, 3, 4, 5, 6, 7 };
  double best = 1e30;
  unsigned long long sum = 0;
  for (int rep = 0; rep < reps; rep++) {
    sum = 0;
    double t0 = now_ms();
    for (int py = 0; py < size; py++) {
      f8 in[4], out[5];
      f8 rowacc = (f8)0.0f;
      in[1] = (f8)((float)py + 0.5f);
      in[2] = (f8)(float)size;
      in[3] = (f8)(float)size;
      for (int px = 0; px < size; px += 8) {
        in[0] = (f8)((float)px + 0.5f) + lane;
        frag(in, out);
        for (int c = 0; c < 4; c++) {
          f8 v = __builtin_elementwise_max(out[c], (f8)0.0f);
          v = __builtin_elementwise_min(v, (f8)1.0f);
          rowacc += __builtin_elementwise_trunc(v * 255.0f + 0.5f);
        }
      }
      for (int l = 0; l < 8; l++) sum += (unsigned long long)rowacc[l];
    }
    double dt = now_ms() - t0;
    if (dt < best) best = dt;
  }
  printf("ms %.3f\nMPix/s %.2f\nsum %llu\n", best, (double)size * size / best / 1000.0, sum);
}

/* `glsl_frag8` -> `glsl_frag8_<idx>`。
 *
 * 常驻宿主要在**同一个 LLJIT** 里编很多个变体，而每份 IR 里的入口都叫 `glsl_frag8` ——
 * 同名符号加第二遍就是重复定义。真 JIT 里变体本来就有自己的名字（llvmpipe 是「按状态
 * 做键」），所以这里给每个变体一个唯一名，而不是去开一堆 JITDylib：
 * 后者要走 ExecutionSession 那套异步 lookup，代价与收益不成比例。
 *
 * 只做**记号级**替换：这个名字在我们发射的 IR 里只出现在 `define` 那一行。 */
static char *rename_frag(const char *src, size_t len, int idx, size_t *out_len) {
  const char *pat = "glsl_frag8";
  const size_t plen = 10;
  char suffix[24];
  snprintf(suffix, sizeof(suffix), "glsl_frag8_%d", idx);
  const size_t slen = strlen(suffix);
  /* 每处最多长 slen - plen 字节，按最坏情况一次分配够。 */
  char *out = (char *)malloc(len + (len / plen + 1) * (slen - plen) + 1);
  if (out == NULL) return NULL;
  size_t o = 0;
  for (size_t i = 0; i < len;) {
    if (i + plen <= len && memcmp(src + i, pat, plen) == 0) {
      memcpy(out + o, suffix, slen);
      o += slen;
      i += plen;
      continue;
    }
    out[o++] = src[i++];
  }
  out[o] = 0;
  *out_len = o;
  return out;
}

/* 一份 IR -> 一个函数指针。`*compile_ms` 只量 Lookup（ORC 惰性物化，编译在那儿）。 */
static frag8_fn jit_variant(LLVMOrcLLJITRef jit, LLVMOrcJITDylibRef jd,
                            const char *ir, size_t len, int idx,
                            double *parse_ms, double *compile_ms) {
  size_t rlen = 0;
  char *renamed = idx < 0 ? NULL : rename_frag(ir, len, idx, &rlen);
  const char *body = renamed == NULL ? ir : renamed;
  const size_t blen = renamed == NULL ? len : rlen;

  LLVMContextRef ctx = LLVMContextCreate();
  /* MemoryBuffer 接管这段字节的所有权（不复制），所以不能提前 free。 */
  LLVMMemoryBufferRef mb = LLVMCreateMemoryBufferWithMemoryRange((char *)body, blen, "<stdin>", 0);
  LLVMModuleRef mod = NULL;
  char *msg = NULL;
  double t0 = now_ms();
  if (LLVMParseIRInContext(ctx, mb, &mod, &msg) != 0) {
    fprintf(stderr, "omni-glsl-jit: 不是合法 IR: %s\n", msg == NULL ? "?" : msg);
    LLVMDisposeMessage(msg);
    return NULL;
  }
  *parse_ms = now_ms() - t0;

  LLVMOrcThreadSafeContextRef tsc = LLVMOrcCreateNewThreadSafeContext();
  LLVMOrcThreadSafeModuleRef tsm = LLVMOrcCreateNewThreadSafeModule(mod, tsc);
  LLVMErrorRef err = LLVMOrcLLJITAddLLVMIRModule(jit, jd, tsm);
  if (err != NULL) { fail_err(err, "cannot add module"); return NULL; }

  char sym[24];
  if (idx < 0) snprintf(sym, sizeof(sym), "glsl_frag8");
  else snprintf(sym, sizeof(sym), "glsl_frag8_%d", idx);
  LLVMOrcJITTargetAddress addr = 0;
  double t1 = now_ms();
  err = LLVMOrcLLJITLookup(jit, &addr, sym);
  if (err != NULL) { fail_err(err, "cannot materialize"); return NULL; }
  *compile_ms = now_ms() - t1;
  return (frag8_fn)addr;
}

/**
 * 常驻宿主：**一次进程，连着吃很多份 IR**。这才是 llvmpipe 的真实形态 —— 它在 GL 驱动
 * 里活着，用户改一个开关就要一个新变体。
 *
 * 协议（stdin）：重复的 `<十进制字节数>\n<那么多字节 IR>`，读到 EOF 为止。
 * 每份印一行 `variant I compile_ms X parse_ms Y`，末尾印 `variants N`。
 */
static int serve(LLVMOrcLLJITRef jit, LLVMOrcJITDylibRef jd) {
  int idx = 0;
  for (;;) {
    long need = 0;
    if (scanf("%ld", &need) != 1) break;
    int ch = getchar();                      /* 吃掉长度后面那个换行 */
    if (ch == EOF) break;
    if (need <= 0) break;
    char *ir = (char *)malloc((size_t)need + 1);
    if (ir == NULL) return 71;
    size_t got = fread(ir, 1, (size_t)need, stdin);
    if (got != (size_t)need) {
      fprintf(stderr, "omni-glsl-jit: 第 %d 份 IR 只读到 %zu / %ld 字节\n", idx, got, need);
      return 66;
    }
    ir[need] = 0;
    double pms = 0;
    double cms = 0;
    frag8_fn frag = jit_variant(jit, jd, ir, (size_t)need, idx, &pms, &cms);
    if (frag == NULL) return 65;
    /* 调一次，确认这个变体真的能跑（而且把「拿到的是活地址」这件事钉住）。 */
    f8 in[4], out[5];
    for (int l = 0; l < 8; l++) { in[0][l] = SX[l]; in[1][l] = SY[l]; }
    in[2] = (f8)1024.0f;
    in[3] = (f8)1024.0f;
    frag(in, out);
    printf("variant %d compile_ms %.3f parse_ms %.3f c0 %.9g\n", idx, cms, pms, (double)out[0][0]);
    fflush(stdout);
    idx++;
  }
  printf("variants %d\n", idx);
  return 0;
}

/* 渲染整幅 + 写一张 PNG（ADR-0019 决策九）。写盘那一步在 `png.c` 里。 */
int png_write_rgba(const char *path, const unsigned char *rgba, int w, int h);

/** 一批最多多少格 `in`：x、y 加上 uniform 的每一格。够 `grapheq.glsl` 用（它是 17）。 */
#define OMNI_MAX_SLOTS 64

/**
 * `out` 有**五格**：r/g/b/a 加一格覆盖度（ADR-0019 那一节）。
 *
 * 覆盖度是 `discard` 的落法（照 llvmpipe 的 kill 掩码）：着色器把"这一道要不要写回"
 * 交回来，1.0 写、0.0 不写。被杀的像素**一个字节都不动** —— 缓冲一开始是清零的，
 * 所以它留着背景（透明黑），这与 GL 里"discard 掉的片元不进帧缓冲"是同一件事。
 * 没有 discard 的着色器存的是常量全 1，所以这一侧只有一种读法。
 */
#define OMNI_OUT_SLOTS 5
#define OMNI_COV_SLOT 4

/**
 * 一条**行块队列**：所有线程从同一个计数器上抢 `RENDER_BLOCK` 行。
 *
 * 为什么是动态抢而不是「一人一段」：像素的代价**不均匀**（掩码一收，一整块就便宜），
 * 平分行数会让某个线程干两倍的活。llvmpipe 那一侧也是一个共享的 tile 队列（`lp_rast`
 * 的调度器），这儿抄的是它那条「谁空谁取下一块」。
 *
 * 线程数：`OMNI_GLSL_THREADS` 优先，否则 `_SC_NPROCESSORS_ONLN`（夹在 1～64）。
 */
#define RENDER_BLOCK 8

typedef struct {
  frag8_fn frag;
  int w, h, nUni;
  const float *uni;
  unsigned char *rgba;
  int next;            /* 下一块的起始行 —— 只用 __atomic_fetch_add 动它 */
} render_job;

/* 一批 8 道的摆法：**两个 2×2 quad**（与 emit_llvm.js 的 run() 一字对齐）
 *
 *     道号：  0 1   4 5      像素：(x,y)   (x+1,y)   (x+2,y)   (x+3,y)
 *             2 3   6 7            (x,y+1) (x+1,y+1) (x+2,y+1) (x+3,y+1)
 *
 * 为什么不是横着一排 8 个：导数（dFdx/dFdy/fwidth）在规范里是**按 quad 定义**的，
 * 摆成 quad 之后着色器那边各只要一次 shufflevector。llvmpipe 一直是这个摆法。
 * 这里的"下一行"按 gl_FragCoord.y 算（规范 7.1：原点在左下，y 往上增），所以是 py+1。 */
static const int LANE_DX[8] = { 0, 1, 0, 1, 2, 3, 2, 3 };
static const int LANE_DY[8] = { 0, 0, 1, 1, 0, 0, 1, 1 };

/** 渲一块行（`[y0, y1)`）。写的是各自不相交的行，所以一把锁都不要。 */
static void render_rows(render_job *j, int y0, int y1) {
  const f8 vdx = { 0, 1, 0, 1, 2, 3, 2, 3 };
  const f8 vdy = { 0, 0, 1, 1, 0, 0, 1, 1 };
  int w = j->w;
  /* 一趟走两行（quad 的高）。块的起点都是 RENDER_BLOCK 的倍数、而它是偶数，
     所以 y0 一定是偶数 —— quad 不会被切开。 */
  for (int py = y0; py < y1; py += 2) {
    f8 in[OMNI_MAX_SLOTS], out[OMNI_OUT_SLOTS];
    for (int u = 0; u < j->nUni; u++) in[2 + u] = (f8)j->uni[u];
    for (int px = 0; px < w; px += 4) {          /* 一趟四列 = 两个 quad 的宽 */
      in[0] = (f8)((float)px + 0.5f) + vdx;
      in[1] = (f8)((float)py + 0.5f) + vdy;
      j->frag(in, out);
      for (int l = 0; l < 8; l++) {
        int x = px + LANE_DX[l];
        int y = py + LANE_DY[l];
        /* 边上多算的那些道**照样算、不写回**：quad 是整个进整个出的，
           这与"宽高不是 2 的倍数"那一档在参考腿上的做法是同一条。 */
        if (x >= w || y >= j->h) continue;
        /* 被 `discard` 杀掉的那一道：这个像素**一个字节都不动**（缓冲是清零的，
         * 所以它留着背景）。判据写成 `== 0.0f` 而不是 `< 0.5f`：这一格是着色器
         * 发出来的常量 0 或 1，不是算出来的数。 */
        if (out[OMNI_COV_SLOT][l] == 0.0f) continue;
        unsigned char *row = j->rgba + (size_t)(j->h - 1 - y) * (size_t)w * 4;
        for (int c = 0; c < 4; c++) {
          float v = out[c][l];
          /* NaN 落到 0：`v > 0` 对 NaN 是假，所以这个写法顺带把 NaN 也夹住了。 */
          v = v > 0.0f ? (v < 1.0f ? v : 1.0f) : 0.0f;
          row[(size_t)x * 4 + c] = (unsigned char)(v * 255.0f + 0.5f);
        }
      }
    }
  }
}

static void *render_worker(void *p) {
  render_job *j = (render_job *)p;
  for (;;) {
    int y0 = __atomic_fetch_add(&j->next, RENDER_BLOCK, __ATOMIC_RELAXED);
    if (y0 >= j->h) return NULL;
    int y1 = y0 + RENDER_BLOCK < j->h ? y0 + RENDER_BLOCK : j->h;
    render_rows(j, y0, y1);
  }
}

static int render_threads(void) {
  const char *e = getenv("OMNI_GLSL_THREADS");
  long n = e != NULL && *e != '\0' ? strtol(e, NULL, 10) : sysconf(_SC_NPROCESSORS_ONLN);
  if (n < 1) n = 1;
  if (n > 64) n = 64;
  return (int)n;
}

/**
 * 渲染一帧写 PNG。
 *
 * uniform 的值由**命令行**按声明次序逐格给 —— 宿主不认识 GLSL，不该去猜哪个 uniform
 * 占几格。谁知道布局？发 IR 的那一侧（`omni run`）。这条分工与「IR 走 stdin」是同一个
 * 道理：宿主只做"一个进程、不落盘、按指针调用"这三件事。
 *
 * **行序要翻**：`gl_FragCoord.y = 0` 是画布最下面（见 ADR「量：gl_FragCoord.y 与缓冲
 * 行序」），而 PNG 的第 0 行是最上面。所以第 py 行写到 `h - 1 - py`。
 *
 * **多线程**：行块队列（见 `render_job`）。每道 8 个像素的那个函数是纯的（局部量都在
 * 它自己的栈上，模块级变量在快路上也是 `alloca`），所以并行不改一个字节 —— 那一条由
 * `tests/glsl/examples.js` 钉着（27 张图与真 GPU 逐字节相同，线程数换了照样相同）。
 */
static int render(frag8_fn frag, int w, int h, const char *path,
                  const float *uni, int nUni) {
  if (w <= 0 || h <= 0 || 2 + nUni > OMNI_MAX_SLOTS) return 64;
  /* **清零**（不是 malloc）：被 `discard` 杀掉的像素一个字节都不写，留下的就是这里的零 ——
   * 透明黑，与 GL 里"没有片元写到那儿"是同一件事。 */
  unsigned char *rgba = (unsigned char *)calloc((size_t)w * (size_t)h * 4, 1);
  if (rgba == NULL) return 70;
  render_job job;
  job.frag = frag;
  job.w = w;
  job.h = h;
  job.nUni = nUni;
  job.uni = uni;
  job.rgba = rgba;
  job.next = 0;
  int nt = render_threads();
  double t0 = now_ms();
  if (nt <= 1) {
    render_rows(&job, 0, h);
  } else {
    pthread_t th[64];
    int made = 0;
    for (int i = 0; i < nt - 1; i++) {
      if (pthread_create(&th[made], NULL, render_worker, &job) == 0) made++;
    }
    render_worker(&job);   /* 主线程也是一个工人 */
    for (int i = 0; i < made; i++) pthread_join(th[i], NULL);
    nt = made + 1;
  }
  double ms = now_ms() - t0;
  int rc = png_write_rgba(path, rgba, w, h);
  free(rgba);
  if (rc != 0) {
    fprintf(stderr, "omni-glsl-jit: 写 %s 失败（png_write_rgba 回 %d）\n", path, rc);
    return 74;
  }
  fprintf(stderr, "render_ms %.3f\n", ms);
  printf("render_ms %.3f\nthreads %d\n%s %dx%d\n", ms, nt, path, w, h);
  return 0;
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "--bench";

  double t_init0 = now_ms();
  LLVMInitializeNativeTarget();
  LLVMInitializeNativeAsmPrinter();
  LLVMOrcLLJITRef jit = NULL;
  LLVMErrorRef err = LLVMOrcCreateLLJIT(&jit, NULL);
  if (err != NULL) return fail_err(err, "cannot create LLJIT");
  double init_ms = now_ms() - t_init0;

  LLVMOrcJITDylibRef jd = LLVMOrcLLJITGetMainJITDylib(jit);
  LLVMOrcDefinitionGeneratorRef gen = NULL;
  /* 进程符号搜索：IR 里的 `llvm.sin.v8f32` 一族会被 LLVM 降成 `sinf` 之类的调用，
     靠这条在**本进程**里找到（宿主链了 -lm）。一层胶水都没有。 */
  err = LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess(
    &gen, LLVMOrcLLJITGetGlobalPrefix(jit), NULL, NULL);
  if (err != NULL) return fail_err(err, "cannot create process symbol generator");
  LLVMOrcJITDylibAddGenerator(jd, gen);

  if (strcmp(mode, "--serve") == 0) {
    fprintf(stderr, "init_ms %.3f\n", init_ms);
    printf("init_ms %.3f\n", init_ms);
    fflush(stdout);
    return serve(jit, jd);
  }

  size_t len = 0;
  char *text = slurp_stdin(&len);
  if (text == NULL || len == 0) {
    fprintf(stderr, "omni-glsl-jit: stdin 上没有 IR\n");
    return 66;
  }
  double parse_ms = 0;
  double compile_ms = 0;
  /* 单份模式：`idx < 0` 表示不改名，符号照旧是 `glsl_frag8`。 */
  frag8_fn frag = jit_variant(jit, jd, text, len, -1, &parse_ms, &compile_ms);
  if (frag == NULL) return 65;

  fprintf(stderr, "init_ms %.3f\nparse_ms %.3f\ncompile_ms %.3f\n", init_ms, parse_ms, compile_ms);
  printf("compile_ms %.3f\n", compile_ms);

  if (strcmp(mode, "--samples") == 0) {
    samples(frag, argc > 2 ? (float)atoi(argv[2]) : 1024.0f);
  } else if (strcmp(mode, "--render") == 0) {
    /* omni-glsl-jit --render W H OUT.png [uniform 的每一格…] < frag.ll */
    if (argc < 5) {
      fprintf(stderr, "用法：omni-glsl-jit --render W H OUT.png [uniform 每一格…]\n");
      return 64;
    }
    float uni[OMNI_MAX_SLOTS];
    int nUni = 0;
    for (int a = 5; a < argc && nUni < OMNI_MAX_SLOTS - 2; a++) uni[nUni++] = (float)atof(argv[a]);
    return render(frag, atoi(argv[2]), atoi(argv[3]), argv[4], uni, nUni);
  } else {
    bench(frag, argc > 2 ? atoi(argv[2]) : 1024, argc > 3 ? atoi(argv[3]) : 3);
  }
  /* 故意不 DisposeLLJIT：被 JIT 的代码可能还持有东西，而这个进程马上就退。 */
  return 0;
}

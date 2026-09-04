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
 *     out = [r, g, b, a]
 *
 *   用法：
 *     omni-glsl-jit --samples RES        < frag.ll
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
  f8 in[4], out[4];
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
      f8 in[4], out[4];
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

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "--bench";
  size_t len = 0;
  char *text = slurp_stdin(&len);
  if (text == NULL || len == 0) {
    fprintf(stderr, "omni-glsl-jit: stdin 上没有 IR\n");
    return 66;
  }

  double t_init0 = now_ms();
  LLVMInitializeNativeTarget();
  LLVMInitializeNativeAsmPrinter();
  LLVMOrcLLJITRef jit = NULL;
  LLVMErrorRef err = LLVMOrcCreateLLJIT(&jit, NULL);
  if (err != NULL) return fail_err(err, "cannot create LLJIT");
  double init_ms = now_ms() - t_init0;

  LLVMContextRef ctx = LLVMContextCreate();
  /* MemoryBuffer 接管 text 的所有权（不复制），所以不能提前 free。 */
  LLVMMemoryBufferRef mb = LLVMCreateMemoryBufferWithMemoryRange(text, len, "<stdin>", 0);
  LLVMModuleRef mod = NULL;
  char *msg = NULL;
  double t_parse0 = now_ms();
  if (LLVMParseIRInContext(ctx, mb, &mod, &msg) != 0) {
    fprintf(stderr, "omni-glsl-jit: stdin 上的不是合法 IR: %s\n", msg == NULL ? "?" : msg);
    LLVMDisposeMessage(msg);
    return 65;
  }
  double parse_ms = now_ms() - t_parse0;

  LLVMOrcJITDylibRef jd = LLVMOrcLLJITGetMainJITDylib(jit);
  LLVMOrcDefinitionGeneratorRef gen = NULL;
  /* 进程符号搜索：IR 里的 `llvm.sin.v8f32` 一族会被 LLVM 降成 `sinf` 之类的调用，
     靠这条在**本进程**里找到（宿主链了 -lm）。一层胶水都没有。 */
  err = LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess(
    &gen, LLVMOrcLLJITGetGlobalPrefix(jit), NULL, NULL);
  if (err != NULL) return fail_err(err, "cannot create process symbol generator");
  LLVMOrcJITDylibAddGenerator(jd, gen);

  LLVMOrcThreadSafeContextRef tsc = LLVMOrcCreateNewThreadSafeContext();
  LLVMOrcThreadSafeModuleRef tsm = LLVMOrcCreateNewThreadSafeModule(mod, tsc);
  err = LLVMOrcLLJITAddLLVMIRModule(jit, jd, tsm);
  if (err != NULL) return fail_err(err, "cannot add module");

  /* **这一句就是编译**（ORC 惰性物化），所以 `compile_ms` 只量它。 */
  LLVMOrcJITTargetAddress addr = 0;
  double t_c0 = now_ms();
  err = LLVMOrcLLJITLookup(jit, &addr, "glsl_frag8");
  if (err != NULL) return fail_err(err, "cannot materialize glsl_frag8");
  double compile_ms = now_ms() - t_c0;

  fprintf(stderr, "init_ms %.3f\nparse_ms %.3f\ncompile_ms %.3f\n", init_ms, parse_ms, compile_ms);
  printf("compile_ms %.3f\n", compile_ms);

  /* 按指针调用 —— 这一格才是与 llvmpipe 等效的地方。 */
  frag8_fn frag = (frag8_fn)addr;

  if (strcmp(mode, "--samples") == 0) {
    samples(frag, argc > 2 ? (float)atoi(argv[2]) : 1024.0f);
  } else {
    bench(frag, argc > 2 ? atoi(argv[2]) : 1024, argc > 3 ? atoi(argv[3]) : 3);
  }
  /* 故意不 DisposeLLJIT：被 JIT 的代码可能还持有东西，而这个进程马上就退。 */
  return 0;
}

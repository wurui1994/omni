/* tests/glsl/fast_driver.c —— 快路的驱动（ADR-0019 决策六，开工单第 2、3 步）
 *
 * 与 `src/core/frontend-glsl/emit_llvm.js` 发出来的 `@glsl_frag8` 拼在一起编：
 *
 *   clang -O2 fast_driver.c frag.ll -lm -o fast
 *   ./fast bench 1024     # 扫整张画布，印 ms / MPix/s / 校验和
 *   ./fast samples 1024   # 印 8 个取样点的四个通道（给对账门比）
 *
 * ABI 是**三个指针**（见 emit_llvm.js 里 `run()` 的注释）：
 *
 *   in  = [x, y, uniform 每一格…]，每格 8 道 f32
 *   out = [r, g, b, a, 覆盖度]
 *   tex = 纹素（RGBA、行优先、各张连着放），逐道 gather 用的普通标量数组
 *
 * 这一份两处调用都传 `NULL`：这条轴上的着色器没有采样器，那个指针一次也不会被读。
 *
 * 第一版把 `float8` 直接当参数传，读出来整体错位一格 —— 32 字节向量在 AArch64 上
 * 不是原生寄存器类型，「IR 的 `<8 x float>` 参数」与「C 的 `ext_vector_type(8)` 参数」
 * 在传参上不必一致。指针没有这个问题。
 *
 * 两件事照 ADR「快路第一步」量到的教训做：
 *
 *   - 取样点的 x **不逐道写**：`x0 + <0,1,…,7>` 一次向量加法
 *   - 一次 8 个像素，量化与累加也整批做
 *
 * uniform 这一版钉死成 `vec2 u_resolution`（`bench-simple` 那一档）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef float f8 __attribute__((ext_vector_type(8)));

extern void glsl_frag8(const f8 *in, f8 *out, const float *tex);

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

/* 8 个取样点：四角、中间、几个不对称的位置 —— 与对账门里那一份一字不差。 */
static const float SX[8] = { 0.5f, 511.5f, 0.5f, 511.5f, 100.5f, 1023.5f, 37.5f, 700.5f };
static const float SY[8] = { 0.5f, 0.5f, 511.5f, 511.5f, 200.5f, 1023.5f, 900.5f, 13.5f };

static void samples(float res) {
  /* `out` 五格：r/g/b/a 加一格覆盖度（`discard` 的落法，见 emit_llvm.js 的 run()）。
   * 这一份只印颜色 —— 取样点上的对账问的是"算出来的值"，写不写回是驱动那一侧的事。 */
  f8 in[4], out[5];
  for (int l = 0; l < 8; l++) { in[0][l] = SX[l]; in[1][l] = SY[l]; }
  in[2] = (f8)res;
  in[3] = (f8)res;
  glsl_frag8(in, out, NULL);
  for (int l = 0; l < 8; l++) {
    printf("%.9g %.9g %.9g %.9g\n", out[0][l], out[1][l], out[2][l], out[3][l]);
  }
}

static void bench(int size, int reps) {
  const f8 lane = { 0, 1, 2, 3, 4, 5, 6, 7 };
  double best = 1e30;
  unsigned long long sum = 0;
  for (int rep = 0; rep < reps; rep++) {
    sum = 0;
    double t0 = now_ms();
    for (int py = 0; py < size; py++) {
      f8 in[4], out[5];
      f8 rowacc = (f8)0.0f;          /* 一行的校验和整条向量地攒 */
      in[1] = (f8)((float)py + 0.5f);
      in[2] = (f8)(float)size;
      in[3] = (f8)(float)size;
      for (int px = 0; px < size; px += 8) {
        in[0] = (f8)((float)px + 0.5f) + lane;   /* 整条向量地生成 x */
        glsl_frag8(in, out, NULL);
        /* 量化也**整批**做（第 3 步的那一格）：clamp 到 [0,1]、×255、截断，
         * 全是向量指令 —— 从前这儿是每格 8 次标量循环，那把向量化的收益吐回去了。 */
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
  const char *mode = argc > 1 ? argv[1] : "bench";
  if (strcmp(mode, "samples") == 0) {
    samples(argc > 2 ? (float)atoi(argv[2]) : 1024.0f);
    return 0;
  }
  bench(argc > 2 ? atoi(argv[2]) : 1024, argc > 3 ? atoi(argv[3]) : 3);
  return 0;
}

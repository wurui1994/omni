/* tests/glsl/soa_ceiling.c —— 快路的**天花板**（ADR-0019 决策六第三格）
 *
 * 问的是一个数：如果着色器那一半按 llvmpipe 的形状写（8 道 f32 SoA），这台机器
 * 一个核能到多少 MPix/s？这一格**不经过我们的编译器** —— 用 clang -O2 直接量，
 * 量出来的是「值不值得往那个形状走」的上界。三个变体做同样的算术：
 *
 *   f64 标量   —— 现在方言的形状（real 是 double、一次一个片元）
 *   f32 标量   —— 只换精度
 *   f32 × 8 道 —— llvmpipe 的形状（`ext_vector_type`，一条指令 8 个片元）
 *
 * 核心与 `bench-complex.frag` 同一类：30 个圆的 SDF 取 min，再一次 smoothstep。
 *
 *   clang -O2 -o /tmp/soa tests/glsl/soa_ceiling.c -lm && /tmp/soa
 */
#include <stdio.h>
#include <math.h>
#include <time.h>

#define N 30
#define PIX (1024 * 1024)

typedef float f32x8 __attribute__((ext_vector_type(8)));

static double cx[N], cy[N], cr[N];
static float fx[N], fy[N], fr[N];

static void setup(void) {
  for (int k = 0; k < N; k++) {
    cx[k] = 0.13 * (k + 1);
    cy[k] = 0.07 * (k + 1);
    cr[k] = 0.05 + 0.001 * k;
    fx[k] = (float)cx[k];
    fy[k] = (float)cy[k];
    fr[k] = (float)cr[k];
  }
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

static double run_f64(void) {
  double acc = 0.0;
  for (int i = 0; i < PIX; i++) {
    double x = (i & 1023) * (1.0 / 1024.0);
    double y = (i >> 10) * (1.0 / 1024.0);
    double d = 1e30;
    for (int k = 0; k < N; k++) {
      double dx = x - cx[k], dy = y - cy[k];
      double t = sqrt(dx * dx + dy * dy) - cr[k];
      d = t < d ? t : d;
    }
    double s = d / 0.01;
    s = s < 0.0 ? 0.0 : (s > 1.0 ? 1.0 : s);
    acc += s * s * (3.0 - 2.0 * s);
  }
  return acc;
}

static double run_f32(void) {
  float acc = 0.0f;
  for (int i = 0; i < PIX; i++) {
    float x = (i & 1023) * (1.0f / 1024.0f);
    float y = (i >> 10) * (1.0f / 1024.0f);
    float d = 1e30f;
    for (int k = 0; k < N; k++) {
      float dx = x - fx[k], dy = y - fy[k];
      float t = sqrtf(dx * dx + dy * dy) - fr[k];
      d = t < d ? t : d;
    }
    float s = d / 0.01f;
    s = s < 0.0f ? 0.0f : (s > 1.0f ? 1.0f : s);
    acc += s * s * (3.0f - 2.0f * s);
  }
  return acc;
}

static double run_f32x8(void) {
  f32x8 acc = 0.0f;
  for (int i = 0; i < PIX; i += 8) {
    f32x8 x, y;
    for (int l = 0; l < 8; l++) {
      x[l] = ((i + l) & 1023) * (1.0f / 1024.0f);
      y[l] = ((i + l) >> 10) * (1.0f / 1024.0f);
    }
    f32x8 d = 1e30f;
    for (int k = 0; k < N; k++) {
      f32x8 dx = x - fx[k], dy = y - fy[k];
      f32x8 t = __builtin_elementwise_sqrt(dx * dx + dy * dy) - fr[k];
      /* 掩码 + select：llvmpipe 里的 min 就是这一条 */
      d = __builtin_elementwise_min(t, d);
    }
    f32x8 s = d / 0.01f;
    s = __builtin_elementwise_max(s, (f32x8)0.0f);
    s = __builtin_elementwise_min(s, (f32x8)1.0f);
    acc += s * s * ((f32x8)3.0f - (f32x8)2.0f * s);
  }
  float sum = 0.0f;
  for (int l = 0; l < 8; l++) sum += acc[l];
  return sum;
}

int main(void) {
  setup();
  printf("%-10s %10s %12s %10s\n", "变体", "ms", "MPix/s", "校验和");
  struct { const char *name; double (*fn)(void); } vs[] = {
    { "f64 标量", run_f64 }, { "f32 标量", run_f32 }, { "f32 x8", run_f32x8 },
  };
  for (int v = 0; v < 3; v++) {
    double best = 1e30, sum = 0.0;
    for (int rep = 0; rep < 3; rep++) {          /* 三次取最小：噪声只往一个方向 */
      double t0 = now_ms();
      sum = vs[v].fn();
      double dt = now_ms() - t0;
      if (dt < best) best = dt;
    }
    printf("%-10s %10.2f %12.2f %10.3f\n", vs[v].name, best, PIX / best / 1000.0, sum);
  }
  return 0;
}

#version 330 core
// 快路里 bool 那一格的用例（ADR-0019：bool 在快路上是「值只取 0.0/1.0 的 <8 x float>」）。
//
// uniform 的签名与 `bench-simple.frag` **一样**（一个 `vec2 u_resolution`）——
// `fast_driver.c` 那一版的 in 布局是钉死的，换签名就得连驱动一起改。
//
// 这一份刻意把每一种 bool 的来路都用上：比较、`&&`/`||`/`!`、`?:`、`isnan`/`isinf`、
// `lessThan` 那一族与 `all`/`any`，外加 `if` / `else if` / `else`（快路上落成掩码 +
// `select`，没有分支）。NaN/Inf 从 `sqrt(-1)` 与 `-log(0)` 来（方言那条路上造不出它们，
// 见 fns.js 里那一节）。
out vec4 fragColor;
uniform vec2 u_resolution;
// 平结构体（B13）：成员是 vec2 + float，摊平之后 3 格
struct Sample { vec2 uv; float w; };
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;

    // 比较 + 逻辑：棋盘格
    bool left = uv.x < 0.5;
    bool top = uv.y < 0.5;
    float checker = (left && top) || (!left && !top) ? 1.0 : 0.25;

    // ?: 的两支都会被算（SIMD 上没有短路）；不该走的那一支这里故意能出 Inf
    float safe = uv.x > 0.0 ? 1.0 / uv.x : 0.0;

    // isnan / isinf
    float nan = sqrt(-1.0);
    float inf = -log(0.0);
    float flags = (isnan(nan) ? 0.5 : 0.0) + (isinf(inf) ? 0.25 : 0.0)
        + (isnan(uv.x) || isinf(uv.y) ? 0.125 : 0.0);

    // 向量比较那一族 + all/any
    bvec2 lt = lessThan(uv, vec2(0.75, 0.75));
    float band = all(lt) ? 0.75 : (any(lt) ? 0.5 : 0.25);

    // if / else if / else —— 快路上落成掩码 + select（没有分支）
    float step2 = 0.0;
    if (uv.x + uv.y > 1.5) {
        step2 = 0.5;
    } else if (uv.x > uv.y) {
        float half2 = uv.x * 0.5;   // 支内的声明出不了这一支
        step2 = half2;
    } else {
        step2 = 0.125;
    }

    // 平结构体（B13）：构造 + 成员访问，在快路上就是分量表的切片
    Sample sm = Sample(uv, 0.25);
    float sv = sm.uv.x * 0.5 + sm.uv.y * 0.25 + sm.w;

    // 数组（B14）：常量下标是切片、变量下标是 select 链（8 道各自的下标不一样）。
    // `pick` 刻意由比较造出来 —— 它在每条腿上都**正好是整数**，不经过 float->int 截断
    // （那一格是另一个待办：快路上 int 就是「值恰好是整数的 float」）。
    vec2 tab[3];
    tab[0] = vec2(0.125, 0.25);
    tab[1] = vec2(0.5, 0.75);
    tab[2] = uv;
    int pick = uv.x < 0.33 ? 0 : (uv.x < 0.66 ? 1 : 2);
    tab[pick].y = 0.875;               // 变量下标 + swizzle 当左值：只动那一格
    float av = tab[pick].x + tab[pick].y * 0.5 + tab[1].x * 0.25 + tab[0].y * 0.125;

    // float -> int 是**真截一次**（GLSL 5.4.1：往零）。快路上 int 是「值恰好是整数的
    // float」，所以这一格要发 `llvm.trunc` —— 不发的话 1.7 会当下标去比 1.0，
    // 与参照实现那边的 `toint` 给出不同的答案。
    int cut = int(uv.x * 2.9);
    float cv = tab[cut].x + float(cut) * 0.0625;

    fragColor = vec4(checker, min(safe, 1.0), flags + band, sv + av * 0.5 + cv * 0.25);
}

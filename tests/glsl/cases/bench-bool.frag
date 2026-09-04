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

    fragColor = vec4(checker, min(safe, 1.0), flags + band, step2 + 0.5);
}

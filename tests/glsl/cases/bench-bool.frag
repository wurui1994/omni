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

    // float -> int 是**真截一次**（GLSL 5.4.1：往零）。决策十第 1 步之后这在快路上是
    // 一条 `fptosi` —— 之前是「值恰好是整数的 float」，所以这一格一直是错的。
    int cut = int(uv.x * 2.9);
    float cv = tab[cut].x + float(cut) * 0.0625;

    // 整数那一族（决策十第 1 步兑的钱）：分量带类型之后 `%`、位运算、移位、`~` 才落得
    // 下来。上一版这些在快路上一条都收不了（int 是 float，位模式无从谈起）。
    int ia = int(uv.y * 7.0);
    int ib = ia % 3;                    // srem
    int ic = (ia << 2) | 1;             // shl / or
    int id = ic & 6;                    // and
    int ie = ~ia ^ 5;                   // xor
    int ig = ic >> 1;                   // ashr（GLSL 的 int 是有符号的）
    float ivv = float(ib) * 0.5 + float(id) * 0.25
        + float(ie) * 0.125 + float(ig) * 0.0625;

    // 位转换来回一趟。**这一条与宽度无关**，所以四条路都该给同一个数 —— 参照腿是
    // f64/i64、快路是 f32/i32，但「转过去再转回来」两边都是恒等。
    float rt = intBitsToFloat(floatBitsToInt(uv.y)) - uv.y;

    // ---- 循环那一族（决策十第 4 步）------------------------------------------------
    // 快路上这些是**真循环 + 掩码栈**（lp_exec_bgnloop/endloop 那一套）。上一版一条都
    // 接不了：值在 SSA 里，掩码盖不住，所以 break/continue 无处落。
    //
    // **还差一条**：嵌套 for + break + 数组变量下标（iv_join4 的插入排序）在快路上给的
    // 答案与参照腿不一样。用例与诊断记在 ADR-0019「决策十第 4 步」那一节，
    // 补上之前不放进这一份 —— 放进来就是一条红门，而红门不该长期挂着。

    // iv_join4 的插入排序逐字搬过来：嵌套 for、break、内层游标同时当读写下标。
    // 这一条压的是「新循环的 break 掩码要从『进来时已经不活着的那些道』起算」——
    // 少那一格的时候，外层最后那一圈（本该全掩掉）一进内层就又活了，数组被改。
    vec2 srt[4];
    srt[0] = vec2(3.0, 0.0); srt[1] = vec2(1.0, 0.0);
    srt[2] = vec2(4.0, 0.0); srt[3] = vec2(2.0, 0.0);
    for (int i = 1; i < 4; i++) {
        vec2 key = srt[i];
        int j = i - 1;
        for (; j >= 0; j--) { if (srt[j].x <= key.x) break; srt[j + 1] = srt[j]; }
        srt[j + 1] = key;
    }
    float sortv = srt[0].x + srt[1].x * 10.0 + srt[2].x * 100.0 + srt[3].x * 1000.0;

    // continue：偶数格跳过（`for` 的 step 在 continue 之后照样执行，与 C 同）
    float accv = 0.0;
    for (int n = 0; n < 6; n++) {
        if (n % 2 == 0) continue;
        accv = accv + float(n);
    }

    // while 与 do-while：**每道各自的圈数不一样**（lim 由像素位置决定），
    // 所以这一条压的正是「回边的判据是『还有道活着吗』」
    int lim = int(uv.x * 4.0);
    int w = 0;
    float wv = 0.0;
    while (w < lim) { wv = wv + 1.0; w = w + 1; }
    int d = 0;
    float dv = 0.0;
    do { dv = dv + 2.0; d = d + 1; } while (d < lim);

    fragColor = vec4(checker, min(safe, 1.0), flags + band,
        sv + av * 0.5 + cv * 0.25 + ivv * 0.03125 + rt
        + sortv * 0.001 + accv * 0.01 + wv * 0.1 + dv * 0.05);
}

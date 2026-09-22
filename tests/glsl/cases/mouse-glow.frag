#version 330 core
// 交互那一格的例子：光点跟着**鼠标**走（`u_mouse`），外圈的花纹按**帧号**转（`u_frame`）。
//
// 这两格 uniform 是 Studio 的预览栏喂的（`src/studio/studio.js` 的 `glslRun`）——
// 喂之前它会问源码"你声明成什么类型"（`glslDeclType`）：`u_mouse` 在这儿是 `vec2`
// （Shadertoy 那套写 `vec4 iMouse`，xy 当前、zw 按下那一下），帧号这儿是 `int`。
// 喂错类型不是值不对，是 WebGL 当场报 INVALID_OPERATION、整张图不画。
//
// **鼠标没动过那一趟要好看**：首页的缩略图与 `omni run … -o out.png` 都不喂鼠标，
// 那时 `u_mouse` 是 (0,0)。所以这儿退回一条圆轨（按时间走）—— 不退的话光点缩在
// 左下角，一张缩略图看着像画错了。
//
//   omni run tests/glsl/cases/mouse-glow.frag --size 256 -o glow.png
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform int u_frame;

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float asp = u_resolution.x / u_resolution.y;
    vec2 q = vec2((uv.x - 0.5) * asp, uv.y - 0.5);

    // 鼠标是**画布像素**（y 从下往上，见 glslRun 里那一格）—— 先归一化再摆到 q 那套坐标里
    vec2 m = u_mouse / u_resolution;
    float a = u_time * 0.7;
    vec2 orbit = vec2(cos(a) * 0.25 * asp, sin(a) * 0.25);
    vec2 pick = vec2((m.x - 0.5) * asp, m.y - 0.5);
    bool idle = u_mouse.x <= 0.0 && u_mouse.y <= 0.0;
    vec2 c = idle ? orbit : pick;

    float d = length(q - c);
    float glow = 0.05 / (d * d + 0.02);

    // 外圈：一圈六瓣的花，相位跟着帧号 —— 帧号与时间不是同一件事（暂停时帧号也停）。
    // **一个 atan 都不用**：把方向当复数 z，`z⁶` 的实部就是 cos(6θ)，再乘一格
    // e^{iφ} 把相位转过去（cos(6θ+φ) = Re(z⁶e^{iφ})）。两个理由：我们自己那条
    // glsl -> LLVM 的腿还没接 `atan`（量出来的：`omni run … -o out.png` 当场报），
    // 而这么写只有加减乘，两条腿都跑得过。
    vec2 z = normalize(q - c);
    vec2 z2 = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
    vec2 z3 = vec2(z2.x * z.x - z2.y * z.y, z2.x * z.y + z2.y * z.x);
    vec2 z6 = vec2(z3.x * z3.x - z3.y * z3.y, 2.0 * z3.x * z3.y);
    float ph = float(u_frame) * 0.04;
    float petal = 0.5 + 0.5 * (z6.x * cos(ph) - z6.y * sin(ph));
    float ring = (1.0 - smoothstep(0.0, 0.02, abs(d - 0.26))) * petal;

    // 三层叠起来一次写完（**不用 `+=`**：我们自己那条 glsl -> LLVM 的腿只收 `=`，
    // 量出来的 —— 那条腿是 `omni run … -o out.png` 走的，页面上的 WebGL2 两种都收）
    vec3 col = vec3(0.04, 0.06, 0.11)
        + vec3(0.25, 0.55, 1.0) * glow
        + vec3(1.0, 0.75, 0.3) * ring;
    fragColor = vec4(col, 1.0);
}

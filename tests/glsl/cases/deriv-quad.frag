#version 330 core
// 导数那三条（规范 8.9）的门用例：`dFdx` / `dFdy` / `fwidth`。
//
// 三格刻意挑成"能手算、而且能分辨错法"：
//   r = dFdx(x²/256)   —— **非线性**。它把"按 quad 差分"钉住了：同一个 2×2 quad 里
//                          左右两个像素拿到的是**同一个值**（qx 是 quad 的左列）。
//                          要是哪条腿按"自己与右边一个"差，右列的像素就会大一截。
//   g = dFdy(y²/256)   —— 同上，换成 y 方向（y 往上增，规范 7.1）。
//   b = fwidth(x/8)    —— 线性，恒等于 |1/8| + |0| = 0.125 -> 32/255。
//
// 两条腿的落法完全不同（快路是一次 shufflevector、参考腿是"再跑一趟探邻居"），
// 出来的 8 位像素必须逐字节相同 —— 那正是这一份要证的。
out vec4 fragColor;

void main() {
  float lin = gl_FragCoord.x / 8.0;
  float sqx = gl_FragCoord.x * gl_FragCoord.x / 256.0;
  float sqy = gl_FragCoord.y * gl_FragCoord.y / 256.0;
  fragColor = vec4(dFdx(sqx), dFdy(sqy), fwidth(lin), 1.0);
}

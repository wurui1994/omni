#version 330 core
// 纹理取样（规范 8.7）的门用例：**双线性 + clamp-to-edge**，没有 mip。
//
// 纹理是 2×2 的 RGBA（红 绿 / 蓝 白），画布 4×4，坐标是 `gl_FragCoord.xy / 4`，
// 于是十六个像素刚好把一张图铺满一遍 —— u 走 0.125…0.875，落点覆盖三档：
//
//   - 落在纹素中心（u*w-0.5 是整数）：取那一格本身，权重 0/1，两条腿都不该有插值误差
//   - 落在两格中间：权重 0.5，插值的那一半在这儿露出来
//   - 落在边外（u*w-0.5 < 0 或 > w-1）：clamp-to-edge 把两端夹住，**不是**绕回去
//
// 两条腿的落法完全不同（快路是逐道 gather + 向量算，参考腿是 `(bget …)` 加标量算），
// 出来的 8 位像素必须逐字节相同 —— 那正是这一份要证的。
uniform sampler2D u_tex;

out vec4 fragColor;

void main() {
  fragColor = texture(u_tex, gl_FragCoord.xy / 4.0);
}

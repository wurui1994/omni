// `string(x)`（runstring.in:459 那一族）：只有 `string(Int)` 与
// `string(real x, Int digits=DBL_DIG)` 两条，DBL_DIG 就是 15。
// bool / pair / string 那三档 asy 自己就不收，钉在 strict/string-bool 那边。
// 绘图层要拼 PostScript 文本（坐标是 %.6g），它缺的就是这一个。
write(string(1.5));
write(string(3));
write(string(1 / 3));
write(string(1 / 3, 4));
write(string(2 / 3, 6));
write(string(133.333333, 6));
write(string(3, 4));
write("x=" + string(-0.5) + " y=" + string(1e-5));
write(string(199.5) + " " + string(0) + " lineto");

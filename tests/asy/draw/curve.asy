// EPS 里的**曲线**：`..` 出来的三次段发 curveto，闭合的多一句回到起点再 closepath。
//
// 这一份钉住的是**印数的精度**：坐标是 %.9g，不是 %.6g。psfile.h:160 是裸的
// `*out << " " << x`，看着像"ostream 默认 6 位"，但同一个流在 psfile.h:30 写
// `%%HiResBoundingBox` 时做过 `std::setprecision(9)`，而 precision 是**粘的**、
// 那一行之后再没复位。tri.asy 里的数（98 / 78.4 / 49）在两档下印出来一样，
// 所以那一刀没看出来；这里的控制点一印就露：
//   asy:  -5.60094532 30.5506108 17.8603314 58.7041429 48.9201191 58.7041429 curveto
//   6 位: -5.60095 30.5506 17.8603 58.7041 48.9201 58.7041 curveto
size(100);
draw((0,0)..(50,60)..(100,0), blue);
fill((0,0)..(100,20)..(50,100)..cycle, orange);
draw((10,10)..(90,30)..(50,90)..cycle, purple+linewidth(1.5));
shipout(currentpicture);

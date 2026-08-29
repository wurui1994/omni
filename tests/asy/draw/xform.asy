// EPS 里的**变换**与 `size(w,h)`：变换是在降级前就把点算好的（`rotate(30)*path`），
// 所以 EPS 里看不见矩阵，只看见算完的坐标 —— 这一份钉的是那些坐标两边一样，
// 连带把 %.9g 那一档又量了一遍（rotate(30) 出来的数没有一个是整齐的）。
// `size(200,100)` 解的是两个方向各自的比例，取小的那个。
size(200,100);
draw(rotate(30)*((0,0)--(100,0)), red);
draw(scale(0.5)*((0,0)--(100,100)), blue);
draw(shift(10,10)*((0,0)--(50,0)), green);
draw(rotate(17)*shift(3,4)*scale(1.3)*((0,0)..(40,40)..(80,0)), black+linewidth(1.2));
shipout(currentpicture);

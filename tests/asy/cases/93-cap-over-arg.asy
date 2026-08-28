// 第五十九刀：实参位置上的裸名字，如果它是**外层函数的局部量**，就不该被当成同名的
// 函数重载集。plain_picture.asy:1319 的
// `latticeshade(f,t*g,stroke,fillrule,p,t,false)` 就是这一格 —— `fillrule` 既是
// latticeshade 的形参（pen），又是 plain_pens.asy 里的一个函数名。

// 同名的一族：两个重载的函数
int fillrule(int a) { return 10 * a; }
int fillrule(string s) { return length(s); }

void take(int x) { write(x); }
typedef void vv();

// 闭包里的实参位置：`fillrule` 是 mk 的形参，遮住上面那两个函数
vv mk(int fillrule) {
  return new void() { take(fillrule); };
}
mk(7)();

// 遮住之后，同名的函数在闭包里就取不到了（asy 的名字解析是逐层的）——
// 这里换个名字调，证明那一族本身还在
write(fillrule(3));
write(fillrule("abcd"));

// 不在实参位置上的裸名字（先前就通）：一起钉住，免得回归
vv mk2(int fillrule) {
  return new void() { int y = fillrule + 1; take(y); };
}
mk2(20)();

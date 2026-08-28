// 第六十七刀：文件级的同名**变量**声明在后面时，同名的**函数**还是看得见的。
// 原型是 plain_arrows.asy:337 的 `arrowbar EndArrow(…)=Arrow;` —— 那个 Arrow 是 :325 的
// 函数，而同名的变量 `Arrow=Arrow()` 在 :443 才出现。asy 里变量与函数在同一档里按签名分，
// 顺序解析只挡住那个变量，挡不住早就声明了的函数。

int Arrow(int k) { return k + 1; }
int EndArrow(int k) = Arrow;      // 这里的 Arrow 只有"函数"那一格
int Arrow = Arrow(10);            // 同名的变量在后面，初值是调那个函数
write(EndArrow(2));
write(Arrow);

// 变量声明**之后**，那个名字就是变量了（还是顺序解析）
int useVar() { return Arrow; }
write(useVar());

// 重载集也走同一条：目标类型定案
real pick(real x) { return x; }
real pick(real x, real y) { return x + y; }
real one(real x) = pick;
real two(real x, real y) = pick;
write(one(1.5));
write(two(1, 2));
real pick = 7;
write(pick);

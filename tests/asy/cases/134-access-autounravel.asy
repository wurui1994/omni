// 第六十二刀：`from m access X as Y;` 把 X 体里那些 `autounravel` 成员**一起**带过来。
//
// 量出来的（`asy -noV`）：`only` 那张表里只有类型名，而摊出来的成员各是各的名字 ——
// 所以名字不跟着改。`collections/map.asy:48` 的 `Iterable(iter)` 就是这一格：它是
// `collections/iter.asy:45` 那条 autounravel，而 map.asy 只 access 了 `Iterable_T`。
from mod_au access Box as B, Wrap as W;

// 类型改了名，autounravel 摊出来的名字没改
B b = mkBox(5);
write(b.x);
write(twice(b));

// autounravel 的字段也是同一格
write(made);
made = 3;
write(made);

// 隐式转换：`operator cast` 跟着类型来了
B c = 41;
write(c.x);

// 显式那一条：`operator ecast`
write((int) c);

// 另一个类型上的 cast（构造函数当函数值那种写法）
W w = b;
write(w.b.x);

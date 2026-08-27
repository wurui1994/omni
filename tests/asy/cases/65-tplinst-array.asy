// 模板实例当**数组元素**（第三十三刀）。两处量出来的差都在 type() 的 array-ty 那条路上：
//   - `Box_int[]`：这个单元里的记录名（recVis 的键）要换成那个类型的真名，不换就报
//     "数组元素这一刀只有 int/real/…" 那条 nope，而 asy 是收的；
//   - 模板模块里的 `T[]`，T 是**另一个模板的实例**：顺序解析（recHere）不能拿别名解出来的
//     类型文本去问 —— 那个名字压根不在 recVis 里，会被当成"声明在后面"。
//     `import plain;` 里 collections/iter.asy:14/30/48 三条就是它。
from mod_tbox(T=int) access Box_T as Box_int;
from mod_tarr(T=Box_int) access firstOf, pair;

Box_int[] bs = pair(Box_int(7), Box_int(9));
write(bs.length);
write(firstOf(bs).v);

Box_int[] one;
one.push(Box_int(3));
write(one[0].get());

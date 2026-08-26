// pair[] —— 第八刀。核心方言的 (arr T) 现在收 (vec real 2) 元素。
// 刻意不读没写过的格子：那在 asy 那边是运行期错误（"read uninitialized value from
// array at index 0"），而我们填零值 —— 差别记在 lower.js 的文件头，这里不去踩。
pair[] p = new pair[2];
write(p.length);
p[0] = (1.5, -2.5);
p[1] = (3, 4);
write(p[0]);
write(p[1]);
write(abs(p[1]));

// 花括号初值、push/pop
pair[] q = {(1,1), (2,2)};
q.push((3,3));
write(q.length);
write(q[2]);
write(q.pop());
write(q.length);

// 复数算术照旧：取出来的就是普通 pair
write(p[0] + p[1]);
write(p[0] * p[1]);
write(q[0] - p[0]);

// 切片是复制不是视图
pair[] r = q[0:2];
r[0] = (7,7);
write(q[0]);
write(r[0]);
write(r.length);

// for-each 与整数组输出
pair s = (0,0);
for (pair z : q) {
  s = s + z;
}
write(s);
write(q);

// 穿过函数：引用语义
void bump(pair[] a) {
  a.push((5,5));
}
bump(q);
write(q.length);
write(q[2]);

// 写下标扩长：长度变成下标+1（中间那格 asy 那边是未初始化，不读它）
q[5] = (9,9);
write(q.length);
write(q[5]);

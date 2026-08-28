// `operator iter` 缺一个（这里 struct 里一个都没有）时 for-each 不成：
// asy 那边报 "cannot iterate over expression of type 'Q'" 并退 1。
struct Q { int a; }
Q q;
for (int x : q) write(x);

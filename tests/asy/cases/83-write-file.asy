// 第四十九刀：`write(file, …)` 那一族（builtin.cc:474 的 addWrite）。
// 核心方言只有 `(print …)`，而 print 自己补换行 —— 所以写进去的东西攒在 file.buf 里，
// 攒出整行才交给 print。默认的 suffix 是 `none`（量过：`write(f,"abc")` 不补换行，
// 与不带 file 的 `write(x)` 不是一条）。
file f = output();
write(f, "one", endl);
write(f, "two");
write(f, "-", 3);
write(f, endl);
write(f, "x=", 2.5, endl);
write(f, (1, 2), endl);
write(f, true, endl);
write(f, 7, endl);

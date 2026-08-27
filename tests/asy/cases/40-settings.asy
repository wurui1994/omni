// `access settings;` —— asy 的 `settings` 在真 asy 那边是 **C++ 模块**（settings.cc 里
// `addOption(new …Setting(…))` 那一串）。我们这一侧是 stage0/lib/asy/settings.asy，
// 用 asy 写的一批模块级变量，类型与默认值逐个照那边抄。判分的人是真 asy：下面这五行
// 两边逐字节相同（量出来的，不是照文档抄的）。
//
// 为什么要它：`base/plain.asy` 的第 9 行就是 `access settings;`，不认它连 `import plain;`
// 都进不去。这一份钉住的是"引真的 base"那条线上的第一块砖。
access settings;
write(settings.tex);
write(settings.verbose);
write(settings.prc);
write(settings.outformat == "");
write(settings.thin);

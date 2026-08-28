// asy 给 transform **单个**印字（builtin.cc:861 的 addWrite<transform>，量过
// `write(shift(3,4))` 印 `(3,4,1,0,0,1)`），但**数组那一支不落到 write 上** ——
// 量过 asy 报 "no matching function 'write(transform[])'"（4.6）。
// 这条守的是"补了 transform 的 write 之后没顺手多收一门语言"。
transform[] ts = {identity(), shift(1,2)};
write(ts);

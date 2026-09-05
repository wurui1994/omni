// unit 是**先取倒数再逐分量乘**（pair.h:164 / triple.h:281 的
// `scale=1.0/length(z); pair(z.x*scale,z.y*scale)`），不是逐分量除。
// 浮点上两者不是一回事：a=62.762791874221662 时 `a/sqrt(a*a)` 正好是 1，
// 而 `a*(1.0/sqrt(a*a))` 是 0.99999999999999989；unit((3,-4)) 也不是 (0.6,-0.8)。
// 挡的那一道照抄 fpclassify(scale)==FP_NORMAL：0、非规格化、inf、nan 一律回 (0,0)。
pair a=(62.762791874221662,0);
write(unit(a).x == 1);            // false —— 差最后一位的那个 1
write(unit(a).x - 1);
write(unit(a).y);
pair b=(3,-4);
write(unit(b).x == 0.6);          // false
write(unit(b).x - 0.6);
write(unit(b).y + 0.8);
triple c=(62.762791874221662,0,0);
write(unit(c).x == 1);            // false，triple 上是同一份
write(unit(c).x - 1);
// 零向量：长度 0 不是 FP_NORMAL，回 (0,0)
pair z0=(0,0);
write(unit(z0).x);
write(unit(z0).y);
// 长度溢出成 inf（length 是朴素的 sqrt(x*x+y*y)）：也回 (0,0)，不是 (nan,nan)
pair big=(1e308,1e308);
write(unit(big).x);
write(unit(big).y);
// 长度是非规格化数：同样回 (0,0)
pair tiny=(realMin*1e-10,0);
write(unit(tiny).x);
write(unit(tiny).y);
triple t0=(0,0,0);
write(unit(t0).z);

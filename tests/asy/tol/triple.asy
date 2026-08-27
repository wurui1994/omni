// triple 上要超越函数的那几个：unit / dir(θ,φ) / expi(θ,φ)。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
// 量出来的形状（每条都在 lower.js 的 asy__tunit / texpi / tdir 上方写着）：
//   unit 是逐分量除以**朴素** abs —— unit((1e200,1e200,1e200)) 因此是 (0,0,0)（abs 溢出成 inf），
//   unit((0,0,0)) 是 (0,0,0)（零点有一刀挡着）
//   expi(θ,φ) = (sinθ cosφ, sinθ sinφ, cosθ)（弧度）；dir 收的是**度**
write(unit((1,2,3)));
write(unit((3,4,0)));
write(unit((-3,-4,0)));
write(unit((0,0,0)));
write(unit((1e200,1e200,1e200)));
write(abs(unit((1,2,3))));
write(expi(0.5,1.0));
write(expi(0,0));
write(dir(30,45));
write(dir(90,0));
write(dir(0,0));
write(abs(dir(30,45)));
write(dot(dir(30,45),dir(30,45)));
write(cross(unit((1,0,0)),unit((0,1,0))));

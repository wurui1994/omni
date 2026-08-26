// 超越函数是**故意**没收的，不是漏了。量过（macOS arm64 libm vs V8，随机输入）：
// atan / tan / log / cos 在最后一位（1 ULP）就分叉，run 和 run-c 只要都算 sin 就必然
// 有一天逐字节对不上。收进来的那七个（sqrt/pow/fabs/floor/ceil/round/fmod）是量过相同的。
write(sin(1.0));

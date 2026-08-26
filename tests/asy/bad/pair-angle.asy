// angle 要 atan2，白名单里没有（量过 libm 与 V8 在 atan 的最后一位就分叉）。
// dir/expi 同理要 cos/sin。unit 能写出来，但量不出 asy 用的是乘倒数还是逐分量除。
write(angle((1,1)));

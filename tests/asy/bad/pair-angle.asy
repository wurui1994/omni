// angle 要 atan2、dir/expi 要 cos/sin —— 这几个现在都在 rmath 白名单里（转手宿主的
// 数学库），所以拦在这里的不再是缺原语，是这一刀没接。unit 另有一条：能写出来，
// 但量不出 asy 用的是乘倒数还是逐分量除。
write(angle((1,1)));

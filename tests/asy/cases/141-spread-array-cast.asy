// `... a` 整份接进可变那一格时也走**数组级**的 operator cast（asy 那边是 arrayToArray
// 那一族：pair->guide 有 cast，pair[] -> guide[] 就跟着有）。bsp.asy:138 靠它。
pair[] p={(0,0),(1,0),(1,1)};
path g=operator --(... p)--cycle;
write(length(g));
write(point(g,1));
write(cyclic(g));
// 散着写的那一档照旧（降到元素型）
path h=operator --((0,0),(2,0));
write(length(h));
write(point(h,1));

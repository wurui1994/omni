// 实参个数必须**正好**对上原型：C 没有"缺席就是 undefined"这回事（lower.js 的 cCall）。
import { c_abs } from '../../../stage0/src/host/native_c.js';

console.log(String(c_abs(1, 2)));

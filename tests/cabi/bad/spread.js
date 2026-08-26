// 展开实参不许用：个数要在编译期就能数出来，才谈得上对上原型。
import { c_abs } from '../../../stage0/src/host/native_c.js';

const xs = [1];
console.log(String(c_abs(...xs)));

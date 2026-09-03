// 表里没有的名字不许调（link.js 认出 native_c.js 这条 import 路径之后当场查表）。
import { c_nope } from '../../../src/core/host/native_c.js';

console.log(String(c_nope()));

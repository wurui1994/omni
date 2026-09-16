/* 模块级重名：**链接器自己改名**（`frontend-js/rename.js`）。
 *
 * 这一份要钉住的是"改名不许改语义"那四处陷阱 —— 它们正是文本替换会做错的地方：
 *   * 形参 / 局部 / catch 形参 / for-of 那一格与模块级同名（**遮住了就不许动**）；
 *   * 对象字面量的**键**（`{ op: 7 }`）与成员名（`o.op`）不是名字，不许动；
 *   * 简写 `{ op }` 要展开成 `{ op: 改过的名字 }`；
 *   * 类里的方法名与字段名同理。
 *
 * 三份文件都有模块级的 `op` / `TAG` / `useOp`，拼成一个程序之后必然撞 —— 从前这是硬错
 * （"rename one"），现在链接器留头一个、后来的改成 `名字$模块短名`。
 * 判据是 `node == omni-js == omni-c` 逐行相同。 */
import { TAG as aTag, op as aOp, useOp as aUse, pick, fieldish, shorthand } from './56-module-collide/alpha.js';
import { TAG as bTag, op as bOp, useOp as bUse, localTrap, catchTrap, loopTrap, Holder } from './56-module-collide/beta.js';

const TAG = 'main';
const op = 300;
function useOp() { return op; }

console.log(`${aTag} ${bTag} ${TAG}`);
console.log(`${String(aOp)} ${String(bOp)} ${String(op)}`);
console.log(`${String(aUse())} ${String(bUse())} ${String(useOp())}`);
console.log(`pick=${String(pick(41))}`);
console.log(`field=${String(fieldish())} shorthand=${String(shorthand())}`);
console.log(`local=${String(localTrap())} catch=${catchTrap()} loop=${String(loopTrap())}`);
const h = new Holder();
console.log(`holder=${String(h.op)} ${String(h.readOp())}`);

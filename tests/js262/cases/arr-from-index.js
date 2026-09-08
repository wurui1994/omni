/* Array 上收 fromIndex 的那三格（规范 23.1.3.17 / .21 / .16）：负数从末尾数，越界夹住。
   从前这一格整个被丢掉 —— [1,2,3,2].indexOf(2, 2) 给 1（该是 3），silent 的错答案。 */
console.log([1, 2, 3, 2].indexOf(2, 2), [1, 2, 3, 2].indexOf(2), [1, 2, 3, 2].indexOf(2, -2));
console.log([1, 2, 3, 2].indexOf(2, 4), [1, 2, 3, 2].indexOf(2, -99), [1, 2, 3].indexOf(9, 0));
console.log([1, 2, 3, 2].lastIndexOf(2, 2), [1, 2, 3, 2].lastIndexOf(2), [1, 2, 3, 2].lastIndexOf(2, -3));
console.log([1, 2, 3, 2].lastIndexOf(2, 0), [1, 2, 3, 2].lastIndexOf(2, 99), [1, 2, 3, 2].lastIndexOf(2, -99));
console.log([1, 2, 3].includes(2, 2), [1, 2, 3].includes(2, 1), [1, 2, 3].includes(2, -2), [1, 2, 3].includes(2, -99));
console.log([NaN].includes(NaN, 0), [NaN].indexOf(NaN), [1, 2, 3].includes(3, 99));

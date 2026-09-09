/* null / undefined 上取属性 / 写属性是**能 catch** 的 TypeError（规范 7.3.2 的 GetV 与
   7.3.4 的 SetV 都先 ToObject）。从前这几格是硬错，整个进程当场没了 —— try/catch 拦不住。
   消息照 qjs（node 那边是 "Cannot read properties of null (reading 'x')"，js262 的尺子
   是 qjs）。算出来的键那条路 qjs 不把键印进消息，也照它走。 */
try { null.x; } catch (e) { console.log(e.name, e.message); }
try { undefined.x; } catch (e) { console.log(e.name, e.message); }
try { const o = null; o.x = 1; } catch (e) { console.log(e.name, e.message); }
try { null[0]; } catch (e) { console.log(e.name, e.message); }
try { undefined.f(); } catch (e) { console.log(e.name, e.message); }
try { const u = undefined; u[1] = 2; } catch (e) { console.log(e.name, e.message); }

// 是真的 TypeError，不只是名字像
try { null.x; } catch (e) { console.log(e instanceof TypeError, e instanceof Error); }

// catch 之后照旧往下跑（从前这一句根本到不了）
const after = [1, 2].map((v) => v * 2);
console.log(after.join(","));

// 深一点的一格：链子中间断了
const deep = { a: { b: null } };
try { deep.a.b.c; } catch (e) { console.log(e.message); }
try { deep.z.y; } catch (e) { console.log(e.message); }

// 可选链不该抛（?. 是短路，不是"抛了再吞"）
console.log(String(deep.a.b?.c), String(deep.z?.y), String(deep.z?.y?.x));

// 函数返回 undefined 之后再取属性
function nothing() {}
try { nothing().k; } catch (e) { console.log(e.message); }

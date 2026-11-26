// An async function's try statement takes the jobs the source's does (#1276, #1361 P2): its blocks'
// awaits are the function's own, so its order among other jobs is Node's.
const log = [];
queueMicrotask(() => log.push("m1"));
(async () => {
  try {
    await Promise.reject(1);
  } catch {
    log.push("try-await");
  }
})();
(async () => {
  await null;
  log.push("plain-await");
})();
queueMicrotask(() => log.push("m2"));
(async () => {
  try {
    log.push("t1");
    await null;
    log.push("t2");
    throw new Error("e");
  } catch (e) {
    log.push(`c ${e.message}`);
    await null;
    log.push("c2");
  } finally {
    log.push("f");
  }
  log.push("after");
  return 1;
})().then((v) => log.push(`done ${v}`));
(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      if (i === 1) continue;
      await null;
      log.push(`i${i}`);
    } finally {
      log.push(`fin${i}`);
    }
  }
})();
(async () => {
  try {
    return await Promise.resolve("r");
  } finally {
    log.push("ret-fin");
  }
})().then((v) => log.push(`ret ${v}`));
const tick = () => Promise.resolve();
tick()
  .then(tick)
  .then(tick)
  .then(tick)
  .then(tick)
  .then(() => console.log(log.join(" ")));

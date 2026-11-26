// Rejections handled before the jobs are done (#1361 P2): none ends the program.
const late = Promise.reject(new Error("late"));
queueMicrotask(() => late.catch((e) => console.log("caught late", e.message)));
Promise.reject(new Error("chained"))
  .then(() => console.log("not reached"))
  .catch((e) => console.log("caught", e.message));
(async () => {
  try {
    await Promise.reject(new TypeError("awaited"));
  } catch (e) {
    console.log("caught", e.name, e.message);
  }
})();
console.log("sync done");

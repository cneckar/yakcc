// A rejection nothing handles (#1361 P2): the program ends with it, exit code 1, after its jobs.
Promise.resolve().then(() => console.log("a job first"));
Promise.reject(new RangeError("nobody listens"));
console.log("sync done");

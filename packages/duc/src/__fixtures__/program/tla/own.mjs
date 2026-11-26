// A module that awaits at its top level.
export const order = ["own start"];
export let x = 0;
await null;
x = 1;
order.push("own end");

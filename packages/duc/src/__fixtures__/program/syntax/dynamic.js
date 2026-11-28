// A module with an import() of a computed specifier: resolved when it runs, so it links nothing.
const which = "./mentions.js";
module.exports = () => import(which);

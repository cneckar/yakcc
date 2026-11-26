// A module with an import() of a computed specifier: not in the native subset yet.
const which = "./mentions.js";
module.exports = () => import(which);

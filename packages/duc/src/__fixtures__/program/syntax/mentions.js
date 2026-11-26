// A module that only mentions import() and import.meta in its strings and comments: neither is used.
const message = "'import()' calls can be written, but import.meta cannot here";
module.exports = { message };

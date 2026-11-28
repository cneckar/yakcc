// A JSON module required (#1370): its value.
const data = require("./data.json");
module.exports = { version: data.version, same: () => require("./data.json") === data };

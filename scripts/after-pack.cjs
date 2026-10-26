// electron-builder accepts one afterPack hook. Each step below checks its own
// platform and does nothing elsewhere.
const embedWindowsIcon = require("./embed-windows-icon.cjs").default;
const adhocSign = require("./adhoc-sign.cjs").default;

exports.default = async function afterPack(context) {
  await embedWindowsIcon(context);
  await adhocSign(context);
};

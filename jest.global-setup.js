// Workaround for Node.js v20.10.0+ bug where NODE_V8_COVERAGE causes
// an infinite FinalizationRegistry flush loop on Linux/GitHub Actions.
// https://github.com/nodejs/node/issues/49344
module.exports = async () => {
  if (process.env.NODE_V8_COVERAGE) {
    global.FinalizationRegistry = class {};
  }
};

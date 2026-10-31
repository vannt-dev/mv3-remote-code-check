(() => {
  // node_modules/cdn-helper/index.js
  function workerPath(path) {
    return path || "https://cdn.jsdelivr.net/npm/cdn-helper@1.2.3/worker.min.js";
  }

  // node_modules/@acme/loader/index.js
  function run(code) {
    return new Function(code)();
  }

  // src/background.js
  var own = "https://unpkg.com/own-lib@2.0.0/own.js";
  console.log(workerPath(), own, run("return 1"));
})();

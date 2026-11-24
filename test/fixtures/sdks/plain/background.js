(() => {
  // node_modules/@amplitude/plugin-autocapture-browser/lib/esm/index.js
  var AMPLITUDE_VISUAL_TAGGING_SELECTOR_SCRIPT_URL = "https://cdn.amplitude.com/libs/visual-tagging-selector-1.0.0-alpha.js.gz";
  function autocapture(load2) {
    return load2(AMPLITUDE_VISUAL_TAGGING_SELECTOR_SCRIPT_URL);
  }

  // node_modules/@firebase/auth/dist/esm/index.js
  var scripts = {
    gapiScript: "https://apis.google.com/js/api.js",
    recaptchaV2Script: "https://www.google.com/recaptcha/api.js",
    recaptchaEnterpriseScript: "https://www.google.com/recaptcha/enterprise.js?render="
  };

  // node_modules/mixpanel-browser/dist/mixpanel.module.js
  var mixpanel_module_default = { recorderSrc: "https://cdn.mxpnl.com/libs/mixpanel-recorder.min.js" };

  // node_modules/captcha-wrapper/index.js
  var captcha = "https://www.google.com/recaptcha/api.js";

  // src/background.js
  var load = (src) => Object.assign(document.createElement("script"), { src });
  autocapture(load);
  load(scripts.gapiScript + scripts.recaptchaV2Script + scripts.recaptchaEnterpriseScript);
  load(mixpanel_module_default.recorderSrc + captcha);
  load("https://example.com/own.js");
})();

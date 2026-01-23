const form = document.getElementById("options-form");
const bannerCheckbox = document.getElementById("show-banner");
const imageLazyCheckbox = document.getElementById("enable-image-lazy");
const deferScriptCheckbox = document.getElementById("enable-defer-script");
const spaOnlyCheckbox = document.getElementById("spa-only");
const frameworkDetectionCheckbox = document.getElementById(
  "framework-detection-enabled",
);
const frameworkReactCheckbox = document.getElementById("framework-react");
const frameworkVueCheckbox = document.getElementById("framework-vue");
const frameworkAngularCheckbox = document.getElementById("framework-angular");
const frameworkSvelteCheckbox = document.getElementById("framework-svelte");
const domThresholdEnabledCheckbox = document.getElementById(
  "dom-threshold-enabled",
);
const domNodeThresholdInput = document.getElementById("dom-node-threshold");
const status = document.getElementById("status");

const defaults = {
  showBanner: true,
  imageLazyLoadingEnabled: true,
  deferScriptEnabled: true,
  spaOnly: false,
  frameworkDetectionEnabled: false,
  frameworkTargets: ["react", "vue", "angular", "svelte"],
  optimizationDomThresholdEnabled: false,
  optimizationDomNodeThreshold: 1500,
};

const restoreOptions = async () => {
  const stored = await chrome.storage.sync.get(defaults);
  bannerCheckbox.checked = stored.showBanner;
  imageLazyCheckbox.checked = stored.imageLazyLoadingEnabled;
  deferScriptCheckbox.checked = stored.deferScriptEnabled;
  spaOnlyCheckbox.checked = stored.spaOnly;
  frameworkDetectionCheckbox.checked = stored.frameworkDetectionEnabled;
  frameworkReactCheckbox.checked = stored.frameworkTargets.includes("react");
  frameworkVueCheckbox.checked = stored.frameworkTargets.includes("vue");
  frameworkAngularCheckbox.checked = stored.frameworkTargets.includes("angular");
  frameworkSvelteCheckbox.checked = stored.frameworkTargets.includes("svelte");
  domThresholdEnabledCheckbox.checked = stored.optimizationDomThresholdEnabled;
  domNodeThresholdInput.value = String(stored.optimizationDomNodeThreshold);
};

const saveOptions = async (event) => {
  event.preventDefault();
  const showBanner = bannerCheckbox.checked;
  const imageLazyLoadingEnabled = imageLazyCheckbox.checked;
  const deferScriptEnabled = deferScriptCheckbox.checked;
  const spaOnly = spaOnlyCheckbox.checked;
  const frameworkDetectionEnabled = frameworkDetectionCheckbox.checked;
  const frameworkTargets = [
    frameworkReactCheckbox.checked ? "react" : null,
    frameworkVueCheckbox.checked ? "vue" : null,
    frameworkAngularCheckbox.checked ? "angular" : null,
    frameworkSvelteCheckbox.checked ? "svelte" : null,
  ].filter(Boolean);
  const optimizationDomThresholdEnabled = domThresholdEnabledCheckbox.checked;
  const optimizationDomNodeThreshold = Math.max(
    0,
    Number.parseInt(domNodeThresholdInput.value || "0", 10),
  );
  await chrome.storage.sync.set({
    showBanner,
    imageLazyLoadingEnabled,
    deferScriptEnabled,
    spaOnly,
    frameworkDetectionEnabled,
    frameworkTargets,
    optimizationDomThresholdEnabled,
    optimizationDomNodeThreshold,
  });
  status.textContent = "設定を保存しました。";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
};

form.addEventListener("submit", saveOptions);
restoreOptions();

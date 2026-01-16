const form = document.getElementById("options-form");
const bannerCheckbox = document.getElementById("show-banner");
const imageLazyCheckbox = document.getElementById("enable-image-lazy");
const preconnectCheckbox = document.getElementById("enable-preconnect");
const deferScriptCheckbox = document.getElementById("enable-defer-script");
const whitelistTextarea = document.getElementById("whitelist-domains");
const blacklistTextarea = document.getElementById("blacklist-domains");
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
  preconnectEnabled: true,
  deferScriptEnabled: true,
  whitelistDomains: [],
  blacklistDomains: [],
  spaOnly: false,
  frameworkDetectionEnabled: false,
  frameworkTargets: ["react", "vue", "angular", "svelte"],
  optimizationDomThresholdEnabled: false,
  optimizationDomNodeThreshold: 1500,
};

const parseDomains = (value) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const formatDomains = (domains) => domains.join("\n");

const restoreOptions = async () => {
  const stored = await chrome.storage.sync.get(defaults);
  bannerCheckbox.checked = stored.showBanner;
  imageLazyCheckbox.checked = stored.imageLazyLoadingEnabled;
  preconnectCheckbox.checked = stored.preconnectEnabled;
  deferScriptCheckbox.checked = stored.deferScriptEnabled;
  whitelistTextarea.value = formatDomains(stored.whitelistDomains);
  blacklistTextarea.value = formatDomains(stored.blacklistDomains);
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
  const preconnectEnabled = preconnectCheckbox.checked;
  const deferScriptEnabled = deferScriptCheckbox.checked;
  const whitelistDomains = parseDomains(whitelistTextarea.value);
  const blacklistDomains = parseDomains(blacklistTextarea.value);
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
    preconnectEnabled,
    deferScriptEnabled,
    whitelistDomains,
    blacklistDomains,
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

const form = document.getElementById("options-form");
const bannerCheckbox = document.getElementById("show-banner");
const imageLazyCheckbox = document.getElementById("enable-image-lazy");
const preconnectCheckbox = document.getElementById("enable-preconnect");
const deferScriptCheckbox = document.getElementById("enable-defer-script");
const whitelistTextarea = document.getElementById("whitelist-domains");
const blacklistTextarea = document.getElementById("blacklist-domains");
const status = document.getElementById("status");

const defaults = {
  showBanner: true,
  imageLazyLoadingEnabled: true,
  preconnectEnabled: true,
  deferScriptEnabled: true,
  whitelistDomains: [],
  blacklistDomains: [],
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
};

const saveOptions = async (event) => {
  event.preventDefault();
  const showBanner = bannerCheckbox.checked;
  const imageLazyLoadingEnabled = imageLazyCheckbox.checked;
  const preconnectEnabled = preconnectCheckbox.checked;
  const deferScriptEnabled = deferScriptCheckbox.checked;
  const whitelistDomains = parseDomains(whitelistTextarea.value);
  const blacklistDomains = parseDomains(blacklistTextarea.value);
  await chrome.storage.sync.set({
    showBanner,
    imageLazyLoadingEnabled,
    preconnectEnabled,
    deferScriptEnabled,
    whitelistDomains,
    blacklistDomains,
  });
  status.textContent = "設定を保存しました。";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
};

form.addEventListener("submit", saveOptions);
restoreOptions();

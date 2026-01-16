const form = document.getElementById("options-form");
const bannerCheckbox = document.getElementById("show-banner");
const status = document.getElementById("status");

const restoreOptions = async () => {
  const { showBanner = true } = await chrome.storage.sync.get("showBanner");
  bannerCheckbox.checked = showBanner;
};

const saveOptions = async (event) => {
  event.preventDefault();
  const showBanner = bannerCheckbox.checked;
  await chrome.storage.sync.set({ showBanner });
  status.textContent = "設定を保存しました。";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
};

form.addEventListener("submit", saveOptions);
restoreOptions();

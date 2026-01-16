const toggleButton = document.getElementById("toggle");
const result = document.getElementById("result");

const updateStorage = async () => {
  const { showBanner = true } = await chrome.storage.sync.get("showBanner");
  const nextValue = !showBanner;
  await chrome.storage.sync.set({ showBanner: nextValue });
  result.textContent = nextValue
    ? "バナー表示を有効にしました。"
    : "バナー表示を無効にしました。";
};

toggleButton.addEventListener("click", updateStorage);

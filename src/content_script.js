(() => {
  const bannerId = "web-loading-assist-banner";
  if (document.getElementById(bannerId)) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = bannerId;
  banner.textContent = "Web Loading Assist が有効です";
  banner.style.position = "fixed";
  banner.style.bottom = "16px";
  banner.style.right = "16px";
  banner.style.zIndex = "9999";
  banner.style.padding = "8px 12px";
  banner.style.background = "rgba(20, 20, 20, 0.85)";
  banner.style.color = "#fff";
  banner.style.fontSize = "12px";
  banner.style.borderRadius = "6px";

  document.body.appendChild(banner);
})();

(() => {
  const defaultOptions = {
    scopeSelector: null,
    imageLazySelector: "img",
    largeImageSelector: "img",
    largeImageMinWidth: 800,
    largeImageMinHeight: 600,
    largeImageRootMargin: "200px 0px",
    lazyPlaceholder:
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    preconnect: {
      enabled: true,
      includeFirstParty: true,
      hosts: [
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "https://ajax.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://code.jquery.com",
        "https://unpkg.com",
        "https://www.googletagmanager.com",
        "https://www.google-analytics.com",
      ],
    },
    deferScriptSelector: "script[src]",
    deferScriptExcludeSelector: "[data-critical],[data-no-defer]",
    deferScriptSameOriginOnly: true,
    idleResourceSelector: "[data-idle-src],[data-idle-href]",
    idleTimeout: 2000,
  };

  const settingsDefaults = {
    showBanner: true,
    imageLazyLoadingEnabled: true,
    preconnectEnabled: true,
    deferScriptEnabled: true,
    whitelistDomains: [],
    blacklistDomains: [],
  };

  const normalizeDomainEntry = (value) => value.trim().toLowerCase();

  const matchesDomain = (host, entry) =>
    host === entry || host.endsWith(`.${entry}`);

  const init = async () => {
    const settings = await chrome.storage.sync.get(settingsDefaults);
    const host = window.location.hostname.toLowerCase();
    const whitelist = settings.whitelistDomains
      .map(normalizeDomainEntry)
      .filter(Boolean);
    const blacklist = settings.blacklistDomains
      .map(normalizeDomainEntry)
      .filter(Boolean);

    const isWhitelisted =
      whitelist.length === 0 || whitelist.some((entry) => matchesDomain(host, entry));
    const isBlacklisted = blacklist.some((entry) => matchesDomain(host, entry));

    if (!isWhitelisted || isBlacklisted) {
      return;
    }

    if (settings.showBanner) {
      const bannerId = "web-loading-assist-banner";
      if (!document.getElementById(bannerId)) {
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
      }
    }

    const mergeDeep = (base, override) => {
      if (!override || typeof override !== "object") {
        return { ...base };
      }

      return Object.entries(base).reduce((acc, [key, value]) => {
        if (Array.isArray(value)) {
          acc[key] = Array.isArray(override[key]) ? override[key] : value;
          return acc;
        }

        if (value && typeof value === "object") {
          acc[key] = mergeDeep(value, override[key]);
          return acc;
        }

        acc[key] = Object.prototype.hasOwnProperty.call(override, key)
          ? override[key]
          : value;
        return acc;
      }, {});
    };

    const options = mergeDeep(defaultOptions, window.WebLoadingAssistOptions);
    options.preconnect.enabled =
      options.preconnect.enabled && settings.preconnectEnabled;

    const root = options.scopeSelector
      ? document.querySelector(options.scopeSelector)
      : document;

    if (!root) {
      return;
    }

    const diagnosticThresholds = {
      domNodeCount: 1500,
      maxDepth: 20,
      maxChildrenPerElement: 200,
      offscreenLargeElementHeight: 5000,
      tableCellCount: 50000,
    };

    const buildDiagnosticsReport = () => {
      const rootElement =
        root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;

      if (!rootElement) {
        return {
          generatedAt: new Date().toISOString(),
          thresholds: { ...diagnosticThresholds },
          metrics: {
            domNodeCount: 0,
            maxDepth: 0,
            maxChildrenPerElement: 0,
            offscreenLargeElementCount: 0,
            maxTableCellCount: 0,
          },
          warnings: [],
        };
      }

      let domNodeCount = 0;
      let maxDepth = 0;
      let maxChildrenPerElement = 0;
      let offscreenLargeElementCount = 0;
      let maxTableCellCount = 0;
      const offscreenLargeSamples = [];

      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;

      const stack = [{ node: rootElement, depth: 1 }];
      while (stack.length > 0) {
        const { node, depth } = stack.pop();
        domNodeCount += 1;
        maxDepth = Math.max(maxDepth, depth);
        maxChildrenPerElement = Math.max(
          maxChildrenPerElement,
          node.children.length,
        );

        const rect = node.getBoundingClientRect();
        const height = Math.max(node.offsetHeight || 0, rect.height || 0);
        const isOutsideViewport =
          rect.bottom < 0 ||
          rect.top > viewportHeight ||
          rect.right < 0 ||
          rect.left > viewportWidth;

        if (
          height >= diagnosticThresholds.offscreenLargeElementHeight &&
          isOutsideViewport
        ) {
          offscreenLargeElementCount += 1;
          if (offscreenLargeSamples.length < 5) {
            offscreenLargeSamples.push({
              tagName: node.tagName.toLowerCase(),
              height,
              rect: {
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
              },
            });
          }
        }

        Array.from(node.children).forEach((child) => {
          stack.push({ node: child, depth: depth + 1 });
        });
      }

      rootElement.querySelectorAll("table").forEach((table) => {
        const cellCount = table.querySelectorAll("td, th").length;
        maxTableCellCount = Math.max(maxTableCellCount, cellCount);
      });

      const warnings = [];
      if (domNodeCount >= diagnosticThresholds.domNodeCount) {
        warnings.push({
          id: "dom-node-count",
          label: "DOMノード総数",
          value: domNodeCount,
          threshold: diagnosticThresholds.domNodeCount,
        });
      }
      if (maxDepth >= diagnosticThresholds.maxDepth) {
        warnings.push({
          id: "max-depth",
          label: "ネスト深度",
          value: maxDepth,
          threshold: diagnosticThresholds.maxDepth,
        });
      }
      if (maxChildrenPerElement >= diagnosticThresholds.maxChildrenPerElement) {
        warnings.push({
          id: "max-children",
          label: "1要素あたりの子要素数",
          value: maxChildrenPerElement,
          threshold: diagnosticThresholds.maxChildrenPerElement,
        });
      }
      if (
        offscreenLargeElementCount > 0 &&
        diagnosticThresholds.offscreenLargeElementHeight > 0
      ) {
        warnings.push({
          id: "offscreen-large-elements",
          label: "画面外に配置された巨大要素",
          value: offscreenLargeElementCount,
          threshold: diagnosticThresholds.offscreenLargeElementHeight,
          samples: offscreenLargeSamples,
        });
      }
      if (maxTableCellCount >= diagnosticThresholds.tableCellCount) {
        warnings.push({
          id: "table-cell-count",
          label: "tableのセル数",
          value: maxTableCellCount,
          threshold: diagnosticThresholds.tableCellCount,
        });
      }

      return {
        generatedAt: new Date().toISOString(),
        thresholds: { ...diagnosticThresholds },
        metrics: {
          domNodeCount,
          maxDepth,
          maxChildrenPerElement,
          offscreenLargeElementCount,
          maxTableCellCount,
        },
        warnings,
      };
    };

    const ensureLazyLoading = () => {
      root.querySelectorAll(options.imageLazySelector).forEach((img) => {
        if (!img.hasAttribute("loading")) {
          img.setAttribute("loading", "lazy");
        }
      });
    };

    const normalizeOrigin = (value) => {
      try {
        return new URL(value, window.location.href).origin;
      } catch {
        return null;
      }
    };

    const addPreconnectLinks = () => {
      if (!options.preconnect.enabled) {
        return;
      }

      const origins = new Set();
      options.preconnect.hosts.forEach((host) => {
        const origin = normalizeOrigin(host);
        if (origin) {
          origins.add(origin);
        }
      });

      if (options.preconnect.includeFirstParty) {
        origins.add(window.location.origin);
      }

      const existing = new Set(
        Array.from(document.querySelectorAll('link[rel="preconnect"]')).map(
          (link) => link.href,
        ),
      );

      origins.forEach((origin) => {
        if (existing.has(origin)) {
          return;
        }

        const link = document.createElement("link");
        link.rel = "preconnect";
        link.href = origin;
        link.crossOrigin = "anonymous";
        document.head.appendChild(link);
      });
    };

    const getImageDimensions = (img) => {
      const widthAttr = parseInt(img.getAttribute("width") || "0", 10);
      const heightAttr = parseInt(img.getAttribute("height") || "0", 10);
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;

      return {
        width: naturalWidth || widthAttr,
        height: naturalHeight || heightAttr,
      };
    };

    const shouldLazySwap = (img) => {
      if (img.dataset.src || img.dataset.srcset) {
        return false;
      }

      const { width, height } = getImageDimensions(img);
      if (!width || !height) {
        return false;
      }

      return (
        width >= options.largeImageMinWidth &&
        height >= options.largeImageMinHeight
      );
    };

    const setupLargeImageObserver = () => {
      if (!("IntersectionObserver" in window)) {
        return;
      }

      const observer = new IntersectionObserver(
        (entries, currentObserver) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) {
              return;
            }

            const img = entry.target;
            const dataSrc = img.dataset.src;
            const dataSrcset = img.dataset.srcset;

            if (dataSrc) {
              img.src = dataSrc;
              delete img.dataset.src;
            }

            if (dataSrcset) {
              img.srcset = dataSrcset;
              delete img.dataset.srcset;
            }

            currentObserver.unobserve(img);
          });
        },
        { rootMargin: options.largeImageRootMargin },
      );

      root.querySelectorAll(options.largeImageSelector).forEach((img) => {
        if (!shouldLazySwap(img)) {
          return;
        }

        const currentSrc = img.currentSrc || img.src;
        if (!currentSrc) {
          return;
        }

        img.dataset.src = currentSrc;
        if (img.srcset) {
          img.dataset.srcset = img.srcset;
          img.removeAttribute("srcset");
        }

        img.src = options.lazyPlaceholder;
        img.setAttribute("loading", "lazy");
        observer.observe(img);
      });
    };

    const isSafeToDefer = (script) => {
      if (script.defer || script.async || !script.src) {
        return false;
      }

      if (script.type && script.type !== "text/javascript") {
        return false;
      }

      if (options.deferScriptSameOriginOnly) {
        const scriptOrigin = normalizeOrigin(script.src);
        if (scriptOrigin && scriptOrigin !== window.location.origin) {
          return false;
        }
      }

      return true;
    };

    const deferScripts = () => {
      const scripts = Array.from(
        root.querySelectorAll(options.deferScriptSelector),
      ).filter((script) => {
        if (
          options.deferScriptExcludeSelector &&
          script.matches(options.deferScriptExcludeSelector)
        ) {
          return false;
        }

        return isSafeToDefer(script);
      });

      scripts.forEach((script) => {
        script.defer = true;
      });
    };

    const loadIdleResources = () => {
      root
        .querySelectorAll(options.idleResourceSelector)
        .forEach((element) => {
          if (element.dataset.idleSrc) {
            element.setAttribute("src", element.dataset.idleSrc);
            delete element.dataset.idleSrc;
          }

          if (element.dataset.idleHref) {
            element.setAttribute("href", element.dataset.idleHref);
            delete element.dataset.idleHref;
          }
        });
    };

    const scheduleIdleLoad = () => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(loadIdleResources, {
          timeout: options.idleTimeout,
        });
        return;
      }

      window.setTimeout(loadIdleResources, options.idleTimeout);
    };

    if (settings.imageLazyLoadingEnabled) {
      ensureLazyLoading();
      setupLargeImageObserver();
    }

    addPreconnectLinks();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        window.WebLoadingAssistDiagnostics = buildDiagnosticsReport();
        if (settings.deferScriptEnabled) {
          deferScripts();
        }
        scheduleIdleLoad();
      });
    } else {
      window.WebLoadingAssistDiagnostics = buildDiagnosticsReport();
      if (settings.deferScriptEnabled) {
        deferScripts();
      }
      scheduleIdleLoad();
    }
  };

  init();
})();

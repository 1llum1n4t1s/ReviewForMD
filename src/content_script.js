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
    offscreenLazySelector: "section,article,div,table,ul,ol",
    offscreenLazyMinHeight: 1200,
    offscreenLazyRootMargin: "400px 0px",
    virtualizeListThreshold: 120,
    virtualizeTableRowThreshold: 200,
    virtualizedItemIntrinsicSize: "1px 800px",
    deepTreeDepthThreshold: 14,
    deepTreeMinDescendants: 60,
    lazyPlaceholderBackground: "rgba(0,0,0,0.02)",
  };

  const settingsDefaults = {
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

    const detectFrameworks = () => {
      const detectors = {
        react: () =>
          Boolean(
            window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
              document.querySelector("[data-reactroot],[data-reactid]"),
          ),
        vue: () =>
          Boolean(
            window.__VUE_DEVTOOLS_GLOBAL_HOOK__ ||
              document.querySelector("[data-v-app],[data-vue]"),
          ),
        angular: () =>
          Boolean(
            window.ng || document.querySelector("[ng-version],[ng-app],[data-ng-app]"),
          ),
        svelte: () =>
          Boolean(
            window.__SVELTE_DEVTOOLS_GLOBAL_HOOK__ ||
              document.querySelector("[data-svelte-h]"),
          ),
      };

      return Object.entries(detectors)
        .filter(([, detector]) => detector())
        .map(([name]) => name);
    };

    const detectedFrameworks = detectFrameworks();
    const isSpa = (() => {
      const spaRoots = document.querySelector(
        "#app,#root,#__next,#__nuxt,[data-router-view]",
      );
      const hasHistoryApi =
        typeof window.history?.pushState === "function" &&
        typeof window.history?.replaceState === "function";

      return Boolean(spaRoots && hasHistoryApi) || detectedFrameworks.length > 0;
    })();

    if (settings.spaOnly && !isSpa) {
      return;
    }

    if (settings.frameworkDetectionEnabled) {
      const targetFrameworks = Array.isArray(settings.frameworkTargets)
        ? settings.frameworkTargets.map((name) => name.toLowerCase())
        : [];
      const hasMatch = detectedFrameworks.some((framework) =>
        targetFrameworks.includes(framework),
      );
      if (!hasMatch) {
        return;
      }
    }

    if (settings.showBanner) {
      const indicatorId = "web-loading-assist-indicator";
      if (!document.getElementById(indicatorId)) {
        const styleId = "web-loading-assist-styles";
        if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = `
            #web-loading-assist-indicator {
              position: fixed;
              bottom: 16px;
              right: 16px;
              z-index: 9999;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              font-size: 12px;
              color: #fff;
              background: linear-gradient(135deg, rgba(20, 20, 20, 0.95) 0%, rgba(40, 40, 40, 0.95) 100%);
              border-radius: 8px;
              padding: 12px 16px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
              min-width: 200px;
              max-width: 280px;
              transition: all 0.3s ease;
              cursor: pointer;
            }
            #web-loading-assist-indicator:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
            }
            #web-loading-assist-indicator.collapsed {
              padding: 10px 14px;
              min-width: 160px;
            }
            .wla-indicator-header {
              display: flex;
              align-items: center;
              margin-bottom: 8px;
              font-weight: 600;
            }
            .wla-indicator-icon {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 20px;
              height: 20px;
              margin-right: 8px;
              background: rgba(76, 175, 80, 0.3);
              border-radius: 4px;
              font-size: 10px;
            }
            .wla-indicator-content {
              display: none;
            }
            #web-loading-assist-indicator.expanded .wla-indicator-content {
              display: block;
            }
            .wla-indicator-stat {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 4px 0;
              font-size: 11px;
              line-height: 1.4;
              opacity: 0.9;
            }
            .wla-indicator-stat-label {
              flex: 1;
              color: #ccc;
            }
            .wla-indicator-stat-value {
              font-weight: 600;
              color: #4caf50;
              margin-left: 8px;
              text-align: right;
            }
            .wla-indicator-actions {
              display: flex;
              gap: 6px;
              margin-top: 10px;
              padding-top: 8px;
              border-top: 1px solid rgba(255, 255, 255, 0.1);
            }
            .wla-indicator-action-btn {
              flex: 1;
              padding: 4px 8px;
              background: rgba(76, 175, 80, 0.2);
              border: 1px solid rgba(76, 175, 80, 0.4);
              border-radius: 4px;
              color: #4caf50;
              font-size: 10px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .wla-indicator-action-btn:hover {
              background: rgba(76, 175, 80, 0.3);
              border-color: rgba(76, 175, 80, 0.6);
            }
            .wla-indicator-progress {
              width: 100%;
              height: 3px;
              background: rgba(255, 255, 255, 0.1);
              border-radius: 2px;
              margin-top: 6px;
              overflow: hidden;
            }
            .wla-indicator-progress-bar {
              height: 100%;
              background: linear-gradient(90deg, #4caf50, #81c784);
              border-radius: 2px;
              transition: width 0.3s ease;
            }
          `;
          document.head.appendChild(style);
        }

        const indicator = document.createElement("div");
        indicator.id = indicatorId;
        indicator.className = "collapsed";

        const header = document.createElement("div");
        header.className = "wla-indicator-header";
        header.innerHTML = '<div class="wla-indicator-icon">⚡</div><span>Web Loading Assist</span>';

        const content = document.createElement("div");
        content.className = "wla-indicator-content";

        const stats = document.createElement("div");
        stats.id = "wla-indicator-stats";

        const actions = document.createElement("div");
        actions.className = "wla-indicator-actions";
        const detailsBtn = document.createElement("button");
        detailsBtn.className = "wla-indicator-action-btn";
        detailsBtn.textContent = "詳細";
        detailsBtn.type = "button";
        detailsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const report = window.WebLoadingAssistOptimizationReport;
          if (report) {
            console.log("Web Loading Assist Optimization Report:", report);
            alert("パフォーマンスレポートをコンソールに出力しました。");
          }
        });

        const closeBtn = document.createElement("button");
        closeBtn.className = "wla-indicator-action-btn";
        closeBtn.textContent = "閉じる";
        closeBtn.type = "button";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          indicator.remove();
        });

        actions.appendChild(detailsBtn);
        actions.appendChild(closeBtn);

        content.appendChild(stats);
        content.appendChild(actions);

        indicator.appendChild(header);
        indicator.appendChild(content);

        indicator.addEventListener("click", () => {
          indicator.classList.toggle("collapsed");
          indicator.classList.toggle("expanded");
        });

        document.body.appendChild(indicator);
        window.WebLoadingAssistIndicator = indicator;
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

    const countDomNodes = () => {
      const rootElement =
        root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;

      if (!rootElement) {
        return 0;
      }

      let domNodeCount = 0;
      const stack = [rootElement];
      while (stack.length > 0) {
        const node = stack.pop();
        domNodeCount += 1;
        Array.from(node.children).forEach((child) => {
          stack.push(child);
        });
      }

      return domNodeCount;
    };

    const measureDomStats = () => {
      const rootElement =
        root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;

      if (!rootElement) {
        return {
          domNodeCount: 0,
          layoutCostMs: 0,
        };
      }

      let domNodeCount = 0;
      const stack = [rootElement];
      const start = performance.now();

      while (stack.length > 0) {
        const node = stack.pop();
        domNodeCount += 1;
        node.getBoundingClientRect();
        Array.from(node.children).forEach((child) => {
          stack.push(child);
        });
      }

      return {
        domNodeCount,
        layoutCostMs: Math.round((performance.now() - start) * 100) / 100,
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

    const setupLazyPlaceholderObserver = () => {
      if (!("IntersectionObserver" in window)) {
        return null;
      }

      const placeholderMap = new Map();
      const observer = new IntersectionObserver(
        (entries, currentObserver) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) {
              return;
            }

            const placeholder = entry.target;
            const original = placeholderMap.get(placeholder);
            if (!original || !placeholder.parentNode) {
              currentObserver.unobserve(placeholder);
              placeholderMap.delete(placeholder);
              return;
            }

            placeholder.replaceWith(original);
            currentObserver.unobserve(placeholder);
            placeholderMap.delete(placeholder);
          });
        },
        { rootMargin: options.offscreenLazyRootMargin },
      );

      return { observer, placeholderMap };
    };

    const createPlaceholder = (original, reason, placeholderMap, observer) => {
      const rect = original.getBoundingClientRect();
      const height = Math.max(original.offsetHeight || 0, rect.height || 0);
      const width = Math.max(original.offsetWidth || 0, rect.width || 0);

      const placeholder = document.createElement("div");
      placeholder.dataset.wlaPlaceholder = reason;
      placeholder.style.minHeight = `${height}px`;
      placeholder.style.minWidth = `${width}px`;
      placeholder.style.background = options.lazyPlaceholderBackground;
      placeholder.style.borderRadius = "2px";

      placeholderMap.set(placeholder, original);
      observer.observe(placeholder);
      original.replaceWith(placeholder);
    };

    const isElementOffscreen = (rect, viewportWidth, viewportHeight) =>
      rect.bottom < 0 ||
      rect.top > viewportHeight ||
      rect.right < 0 ||
      rect.left > viewportWidth;

    const lazyRenderOffscreenLargeElements = (placeholderManager) => {
      if (!placeholderManager) {
        return 0;
      }

      const { observer, placeholderMap } = placeholderManager;
      const candidates = Array.from(
        root.querySelectorAll(options.offscreenLazySelector),
      );
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      let replacedCount = 0;

      candidates.forEach((element) => {
        if (
          element.dataset.wlaPlaceholder ||
          element.closest("[data-wla-placeholder]")
        ) {
          return;
        }

        if (["HTML", "BODY"].includes(element.tagName)) {
          return;
        }

        const style = window.getComputedStyle(element);
        if (style.position === "fixed" || style.position === "sticky") {
          return;
        }

        const rect = element.getBoundingClientRect();
        const height = Math.max(element.offsetHeight || 0, rect.height || 0);

        if (
          height < options.offscreenLazyMinHeight ||
          !isElementOffscreen(rect, viewportWidth, viewportHeight)
        ) {
          return;
        }

        createPlaceholder(element, "offscreen-large", placeholderMap, observer);
        replacedCount += 1;
      });

      return replacedCount;
    };

    const virtualizeListsAndTables = () => {
      let virtualizedCount = 0;
      const listSelectors = ["ul", "ol"];
      listSelectors.forEach((selector) => {
        root.querySelectorAll(selector).forEach((list) => {
          const items = Array.from(list.children).filter(
            (child) => child.tagName === "LI",
          );
          if (items.length < options.virtualizeListThreshold) {
            return;
          }

          items.forEach((item) => {
            item.style.contentVisibility = "auto";
            item.style.containIntrinsicSize = options.virtualizedItemIntrinsicSize;
          });
          virtualizedCount += items.length;
        });
      });

      root.querySelectorAll("table").forEach((table) => {
        const rows = Array.from(
          table.querySelectorAll("tbody tr, tr"),
        );
        if (rows.length < options.virtualizeTableRowThreshold) {
          return;
        }

        rows.forEach((row) => {
          row.style.contentVisibility = "auto";
          row.style.containIntrinsicSize = options.virtualizedItemIntrinsicSize;
        });
        virtualizedCount += rows.length;
      });

      return virtualizedCount;
    };

    const mergeUnnecessaryWrappers = () => {
      let mergeCount = 0;
      const rootElement =
        root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
      if (!rootElement) {
        return mergeCount;
      }

      const candidates = Array.from(rootElement.querySelectorAll("div,span"));
      candidates.forEach((wrapper) => {
        if (wrapper.attributes.length > 0) {
          return;
        }

        if (wrapper.childNodes.length !== 1) {
          return;
        }

        const onlyChild = wrapper.firstChild;
        if (!onlyChild || onlyChild.nodeType !== Node.ELEMENT_NODE) {
          return;
        }

        if (!wrapper.parentNode || wrapper === rootElement) {
          return;
        }

        wrapper.replaceWith(onlyChild);
        mergeCount += 1;
      });

      return mergeCount;
    };

    const lazyDeepDisplayTrees = (placeholderManager) => {
      if (!placeholderManager) {
        return 0;
      }

      const { observer, placeholderMap } = placeholderManager;
      const rootElement =
        root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
      if (!rootElement) {
        return 0;
      }

      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      let lazyCount = 0;

      const stack = [{ node: rootElement, depth: 1 }];
      while (stack.length > 0) {
        const { node, depth } = stack.pop();
        const descendantCount = node.querySelectorAll("*").length;
        if (
          depth >= options.deepTreeDepthThreshold &&
          descendantCount >= options.deepTreeMinDescendants
        ) {
          const rect = node.getBoundingClientRect();
          if (isElementOffscreen(rect, viewportWidth, viewportHeight)) {
            createPlaceholder(node, "deep-tree", placeholderMap, observer);
            lazyCount += 1;
            continue;
          }
        }

        Array.from(node.children).forEach((child) => {
          stack.push({ node: child, depth: depth + 1 });
        });
      }

      return lazyCount;
    };

    const updateIndicatorDisplay = (report) => {
      const indicator = window.WebLoadingAssistIndicator;
      if (!indicator) {
        return;
      }

      const statsContainer = document.getElementById("wla-indicator-stats");
      if (!statsContainer) {
        return;
      }

      statsContainer.innerHTML = "";

      if (!report || report.skipped) {
        const message = document.createElement("div");
        message.className = "wla-indicator-stat";
        message.innerHTML = '<span class="wla-indicator-stat-label">最適化をスキップしました</span>';
        statsContainer.appendChild(message);
        return;
      }

      const domReduction = report.before.domNodeCount + report.diff.domNodeCount;
      const reductionRate = report.before.domNodeCount > 0
        ? Math.abs((domReduction / report.before.domNodeCount) * 100)
        : 0;
      const layoutImprovement = -report.diff.layoutCostMs;

      const statItems = [
        {
          label: "最適化処理",
          value: `${report.actions.length}件`,
        },
        {
          label: "DOM削減",
          value: `${Math.abs(domReduction)}個 (${reductionRate.toFixed(1)}%)`,
        },
        {
          label: "レイアウト改善",
          value: `${layoutImprovement.toFixed(2)}ms`,
        },
      ];

      statItems.forEach((item) => {
        const statEl = document.createElement("div");
        statEl.className = "wla-indicator-stat";
        statEl.innerHTML = `
          <span class="wla-indicator-stat-label">${item.label}</span>
          <span class="wla-indicator-stat-value">${item.value}</span>
        `;
        statsContainer.appendChild(statEl);
      });

      if (report.actions.length > 0) {
        const actionList = document.createElement("div");
        actionList.style.marginTop = "8px";
        actionList.style.paddingTop = "8px";
        actionList.style.borderTop = "1px solid rgba(255, 255, 255, 0.1)";
        actionList.style.fontSize = "10px";
        actionList.style.opacity = "0.8";

        report.actions.forEach((action) => {
          const actionEl = document.createElement("div");
          actionEl.style.padding = "2px 0";
          actionEl.textContent = `• ${action.label} (${action.affectedCount}件)`;
          actionList.appendChild(actionEl);
        });

        statsContainer.appendChild(actionList);
      }

      const progressBar = document.createElement("div");
      progressBar.className = "wla-indicator-progress";
      const barInner = document.createElement("div");
      barInner.className = "wla-indicator-progress-bar";
      const improvement = Math.min(100, Math.max(0, reductionRate * 2));
      barInner.style.width = `${improvement}%`;
      progressBar.appendChild(barInner);
      statsContainer.appendChild(progressBar);

      indicator.classList.remove("collapsed");
      indicator.classList.add("expanded");
    };

    const runOptimizationActions = () => {
      const report = {
        generatedAt: new Date().toISOString(),
        before: measureDomStats(),
        after: null,
        actions: [],
      };

      const placeholderManager = setupLazyPlaceholderObserver();
      const offscreenCount = lazyRenderOffscreenLargeElements(placeholderManager);
      if (offscreenCount > 0) {
        report.actions.push({
          id: "offscreen-lazy-render",
          label: "画面外の巨大要素を遅延描画",
          affectedCount: offscreenCount,
        });
      }

      const virtualizedCount = virtualizeListsAndTables();
      if (virtualizedCount > 0) {
        report.actions.push({
          id: "virtualize-long-lists",
          label: "長大なリスト/テーブルの仮想化",
          affectedCount: virtualizedCount,
        });
      }

      const mergedCount = mergeUnnecessaryWrappers();
      if (mergedCount > 0) {
        report.actions.push({
          id: "merge-wrappers",
          label: "不要なネストの統合",
          affectedCount: mergedCount,
        });
      }

      const deepTreeCount = lazyDeepDisplayTrees(placeholderManager);
      if (deepTreeCount > 0) {
        report.actions.push({
          id: "lazy-deep-trees",
          label: "深い表示ツリーの遅延生成",
          affectedCount: deepTreeCount,
        });
      }

      report.after = measureDomStats();
      report.diff = {
        domNodeCount: report.after.domNodeCount - report.before.domNodeCount,
        layoutCostMs: report.after.layoutCostMs - report.before.layoutCostMs,
      };

      updateIndicatorDisplay(report);
      return report;
    };

    const runConditionalOptimizations = () => {
      const domNodeCount = countDomNodes();
      const threshold = Math.max(
        0,
        Number.parseInt(settings.optimizationDomNodeThreshold || "0", 10),
      );

      if (settings.optimizationDomThresholdEnabled && domNodeCount < threshold) {
        window.WebLoadingAssistOptimizationReport = {
          skipped: true,
          reason: "dom-node-threshold",
          evaluatedAt: new Date().toISOString(),
          domNodeCount,
          threshold,
        };
        return;
      }

      window.WebLoadingAssistOptimizationReport = runOptimizationActions();
    };

    if (settings.imageLazyLoadingEnabled) {
      ensureLazyLoading();
      setupLargeImageObserver();
    }

    addPreconnectLinks();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        window.WebLoadingAssistDiagnostics = buildDiagnosticsReport();
        runConditionalOptimizations();
        if (settings.deferScriptEnabled) {
          deferScripts();
        }
        scheduleIdleLoad();
      });
    } else {
      window.WebLoadingAssistDiagnostics = buildDiagnosticsReport();
      runConditionalOptimizations();
      if (settings.deferScriptEnabled) {
        deferScripts();
      }
      scheduleIdleLoad();
    }
  };

  init();
})();

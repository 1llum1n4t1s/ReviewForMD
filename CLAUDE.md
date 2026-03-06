# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) — copies PR titles, descriptions, and review comments as Markdown from GitHub and Azure DevOps. Vanilla JS, no build step. Japanese comments/UI.

## Commands

**Package:** `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS)

No npm, no tests, no linter. Install via `chrome://extensions` → Load unpacked.

## Architecture

### Data flow

```
content_script.js (entry, IIFE)
  → SiteDetector.detect()    → ButtonInjector.inject()
  → MutationObserver (400ms debounce)
  → SPA nav listeners (4 methods)

Button click → Extractor → MarkdownBuilder → Clipboard.copy()
```

### Content script load order matters

Defined in manifest.json `content_scripts.js` array. Each module is an IIFE that exposes a global (`SiteDetector`, `MarkdownBuilder`, etc.), so order determines dependency availability:

site_detector → markdown_builder → clipboard → github_extractor → devops_extractor → button_injector → content_script

### Module pattern

IIFE returning public API object. Private functions prefixed with `_`. No ES modules — all scripts share the global scope within the content script context.

### SPA navigation detection (4 layers)

`content_script.js` listens for navigation via: (1) `chrome.runtime.onMessage` from service worker, (2) custom events from `navigation_hook.js` (injected into main world to hook `history.pushState/replaceState`), (3) `popstate` for browser back/forward, (4) GitHub's `turbo:load` event. All trigger `init()` with 300ms debounce.

### Service worker (`service_worker.js`)

Monitors `webNavigation.onHistoryStateUpdated` and `onCompleted` for PR page URLs. For known domains (github.com, dev.azure.com, *.visualstudio.com), sends `rfmd:navigate` message to content script; falls back to dynamic injection if message fails (content script not yet loaded). For custom domains, always dynamically injects via `chrome.scripting.executeScript`.

### DevOps extraction strategy (3 tiers)

`devops_extractor.js` uses a tiered approach because DevOps is a SPA with lazy-loaded DOM:

1. **DOM extraction** — parses rendered comments from Activity/Discussion tabs and inline file comments
2. **REST API fallback** (`fetchViaApi`) — when DOM comments are missing or incomplete (e.g., unloaded tabs), fetches via `/_apis/git/repositories/.../pullRequests/.../threads` and iterations endpoints
3. **Items API enrichment** (`_enrichWithItemsApi`) — when threads lack diff context (source code lines), fetches file contents and FileDiffs API to reconstruct diff blocks. Batched with max 6 concurrent fetches.

`extractAll()` orchestrates: tries DOM first, falls back to API if comments are missing, then enriches any remaining threads lacking `diffLines` via Items API.

### Site detection

`site_detector.js`: GitHub by domain+path. DevOps known domains (dev.azure.com, *.visualstudio.com) by URL path (case-insensitive). Custom DevOps domains by URL path pattern + 2+ DOM signals (`.repos-pr-details-page`, `bolt-header`, PR tabbar, etc.).

### Button injection

`button_injector.js`: Injects "全てMDコピー" (copy all) button into PR header area and "MDコピー" (copy single) buttons per comment/thread. Uses `_createButton` factory with click handler that calls extractor → MarkdownBuilder → Clipboard. Feedback animation with 1.5s timeout and double-click prevention via `data-rfmd-busy`.

### HTML → Markdown conversion

`markdown_builder.js`: Recursive DOM walker (`_convertNode`) with 80-depth limit. Handles headings, inline formatting, code blocks (with language detection), links (with relative URL resolution), images (data-URI → placeholder), lists (nested with depth tracking), tables, checkboxes. Security: sanitizes dangerous URI schemes, escapes Markdown injection in link text/URLs. Filters out GitHub Code Review Agent badge images.

## Conventions

- `data-rfmd` attributes for DOM targeting and duplicate prevention
- `[ReviewForMD]` prefix on all console output
- Extension context invalidation errors (`Extension context invalidated`) silently caught throughout — this is expected when extension is updated while page is open
- `window.__rfmd_initialized` / `window.__rfmd_nav_hooked__` flags prevent double initialization from dynamic injection
- DevOps API URLs are constructed from URL parsing (`_parseDevOpsUrl`), not hardcoded — supports custom domains
- Markdown output uses Japanese labels: `本文`, `レビューコメント`, `コメント N`, `投稿者`, `日時`, `ファイル`, `対象行`, `↩ 返信`

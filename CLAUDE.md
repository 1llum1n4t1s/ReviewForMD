# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) — copies PR titles, descriptions, and review comments as Markdown from GitHub and Azure DevOps. Vanilla JS, no build step. Japanese comments/UI.

## Commands

**Package:** `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS)

No npm, no tests, no linter. Install via `chrome://extensions` → Load unpacked.

## Architecture

```
content_script.js (entry, IIFE)
  → SiteDetector.detect()    → ButtonInjector.inject()
  → MutationObserver (400ms debounce)
  → SPA nav listeners (4 methods)

Button click → Extractor → MarkdownBuilder → Clipboard.copy()
```

**Content script load order matters** (manifest.json): site_detector → markdown_builder → clipboard → github_extractor → devops_extractor → button_injector → content_script

**Module pattern:** IIFE returning public API. Private functions prefixed `_`.

**DevOps extraction:** DOM → REST API fallback → Items API for diffs (max 6 concurrent)

**Site detection:** GitHub by domain+path. DevOps known domains by URL (case-insensitive). Custom domains by URL path + 2+ DOM signals.

## Conventions

- `data-rfmd` attributes for DOM targeting/duplicate prevention
- `[ReviewForMD]` prefix on console output
- Extension context invalidation errors silently caught

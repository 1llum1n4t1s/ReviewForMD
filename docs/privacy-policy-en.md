# Privacy Policy — Review For MD

**Last Updated: April 19, 2026**

## Overview

Review For MD (the "Extension") is a Chrome extension that helps users with the following:

- Extract pull request titles, descriptions, and review comments from GitHub and Azure DevOps (including custom domains), and either download them as Markdown files or copy them to the clipboard.
- Download meeting transcripts (VTT subtitle files) from SharePoint Stream (Teams meeting recording) pages.

This Extension is designed with maximum respect for user privacy.

## Information We Collect

**This Extension does not collect, transmit, or store any personal information.**

Specifically:

- No personal data (name, email, etc.) is collected
- No cookies or tracking technologies are used
- No data is sent to external servers
- No analytics tools or advertising SDKs are included
- No browsing history is accessed

## Permissions Used

This Extension uses the following browser permissions:

### activeTab

Used to read page content (PR title, body, review comments) from the currently active tab when the user clicks the extension button. Tab content is never accessed without user action.

### scripting

Used to inject copy button UI into target pages (GitHub / Azure DevOps PR pages) and execute scripts to read page content.

### webNavigation

Used to detect page navigation in SPAs (Single Page Applications) like GitHub, ensuring copy buttons are properly displayed when navigating to PR pages.

### host_permissions

Content scripts only operate on the following domains:

- `https://github.com/*`
- `https://*.github.com/*` (GitHub Enterprise support)
- `https://dev.azure.com/*`
- `https://*.visualstudio.com/*`
- `https://*.sharepoint.com/*` (to fetch VTT transcripts from Teams meeting recording pages)

For custom domains (such as self-hosted Azure DevOps instances), `optional_host_permissions` is used. The Extension only operates on an origin if the user has explicitly clicked "Allow this site" for that origin. It does not operate on any domain the user has not explicitly approved.

## Data Processing

Data accessed by this Extension (PR titles, body, review comments, and SharePoint Stream VTT transcripts) is processed exclusively as follows:

- Converted/formatted to Markdown or VTT format in browser memory
- In response to an explicit user action (button click), one of the following is performed:
  - Copied to the clipboard ("Copy as MD" button)
  - Downloaded as a `.md` / `.vtt` file ("Download as MD" / "Download VTT" button)
- Discarded from memory after processing
- Never transmitted to any third-party server by the Extension

## Data Storage

The Extension itself does not persist user data:

- No localStorage usage
- No IndexedDB / chrome.storage usage
- No external server storage

However, when the user clicks the "MDでダウンロード" or "VTTダウンロード" button, the browser's native download mechanism saves a `.md` / `.vtt` file to the user's own Downloads folder. This is an explicit user-initiated save, and the Extension does not access the file after it is saved.

## Third-Party Sharing

Since this Extension does not collect data, no third-party data sharing occurs.

## Children's Privacy

This Extension is available for all ages and does not collect personal information from any user.

## Open Source

The source code of this Extension is publicly available for anyone to verify its privacy practices.

Repository: [https://github.com/1llum1n4t1s/ReviewForMD](https://github.com/1llum1n4t1s/ReviewForMD)

## Changes to This Policy

If this privacy policy is updated, the "Last Updated" date on this page will be revised. Significant changes will be communicated through extension update notes.

## Contact

For questions about this privacy policy, please contact:

- GitHub: [https://github.com/1llum1n4t1s](https://github.com/1llum1n4t1s)
- Issues: [https://github.com/1llum1n4t1s/ReviewForMD/issues](https://github.com/1llum1n4t1s/ReviewForMD/issues)

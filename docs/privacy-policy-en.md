# Privacy Policy — Review For MD

**Last Updated: February 17, 2026**

## Overview

Review For MD (the "Extension") is a Chrome extension that copies pull request titles, descriptions, and review comments in Markdown format from GitHub and Azure DevOps.

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

The Extension does not operate on any other websites.

## Data Processing

Data accessed by this Extension (PR titles, body, review comments) is processed exclusively as follows:

- Converted to Markdown format in browser memory
- Copied to the user's clipboard
- Discarded from memory after processing
- Never transmitted outside the browser

## Data Storage

This Extension does not store data in any form:

- No localStorage usage
- No IndexedDB usage
- No file system storage
- No external server storage

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

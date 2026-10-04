# Permission Inventories

Status: draft v0.1. Rule: every permission is listed here with its justification before
it appears in a manifest or entitlement file. Anything not listed is not requested.

## Chrome extension (Manifest V3)

| Permission | Type | Justification | Notes |
|---|---|---|---|
| `sidePanel` | manifest | The companion UI | |
| `offscreen` | manifest | MV3 requires an offscreen document (reason `USER_MEDIA`) to consume the tab capture stream | Chrome 116+ pattern |
| `tabCapture` | manifest | Capture the one authorized tab (`getMediaStreamId` on user gesture) | Never desktop capture |
| `activeTab` | manifest | User-gesture-scoped access to the current tab at start | Preferred over host grants where sufficient |
| `storage` | manifest | Session state, org config cache | No captured content stored |
| Per-site host permissions | **optional_host_permissions** | Structured field reads + coaching on org-allowlisted apps only | Requested at enable-time per site from the admin allowlist; **never `<all_urls>`** |

Explicitly NOT requested: `<all_urls>`, `cookies`, `history`, `webRequest` (blocking),
`debugger`, `scripting` on unlisted hosts, `nativeMessaging` (revisit only if a desktop
handoff needs it, as its own reviewed change).

Collection rules enforced in code and tested: no passwords, no hidden/`type=password`
fields, no cookies/auth tokens, no content outside adapter allowlists; messages between
content scripts / service worker / side panel / offscreen are zod-validated and
sender-verified.

## macOS desktop companion

| Permission (TCC) | Requested | Justification / honesty note |
|---|---|---|
| Screen Recording | Yes | Frame capture of the selected app/window via ScreenCaptureKit. **OS grants per-app, not per-window** — selected-scope enforcement happens inside the app and the disclosure says so. |
| Microphone | Yes | Voice conversation with the agent. Shutdown on pause verified against the system orange-dot indicator. |
| Accessibility (AX) | Yes, optional | Read-only structured fields from supported apps where screenshots are insufficient; minimized and treated as untrusted. Feature degrades to visual-only if declined. |
| Input Monitoring | **Never** | We do not collect raw keystrokes. Coarse activity comes from AX focus/notification events within the observed app. |
| Automation (AppleEvents) | **Not in v1** | First release never clicks, types, approves, saves or runs commands in other apps. |
| Full Disk Access | Never | Not needed. |

Secure storage: session token in Keychain via `safeStorage`. No provider keys on device.

## Web app

| Permission (browser prompt) | Justification |
|---|---|
| Microphone (`getUserMedia`) | Voice conversation |
| Tab/screen share (`getDisplayMedia`) | Teach-mode capture; UI instructs sharing *this tab* so on-canvas redaction alignment holds; a non-tab surface is flagged and image upload is suppressed until corrected |

## Change control

Adding any permission requires: entry here with justification, threat-model delta,
acceptance-test update, and (extension) a store-listing diff review before submission.

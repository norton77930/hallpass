# Contract: Screenshot Answers and Debugging Lifetime (031)

## Screenshot tools (`screenshot`, `computer` action `screenshot`, region close-ups)

- The picture contract of spec 012 is unchanged: whole viewport at the frame's CSS size under the
  picture budget, sent as JPEG; regions sent as PNG at native density (R-166, R-280, R-281).
- New refusal: `window-minimized` - "The Chrome window that holds this tab is minimized. Ask the owner
  to restore it, then retry." Nothing is activated or restored.
- The owner's active tab is never changed by a capture, for the tab states R-462 measures as fresh. For
  states measured stale, the current activate-and-restore behaviour remains, and this is documented in
  the tool description.

## Debugging lifetime (observable)

- The browser's debugging state for a tab starts at the first call that needs it (unchanged).
- It ends about 20 s after the last effect or capture call on that tab, unless a GIF recording, an
  emulated viewport or a diagnostics buffer still needs it (R-466).
- A later call re-attaches transparently. The page is told it has focus while attached (R-465).

// Shared so the entry, the component and their tests cannot disagree.
export const DEFAULT_POLL_MS = 2000;

// Placement. Both values are load-bearing and neither is guessable from the types:
//
//   * `sidebar_content` is the slot. The host's MCP and LSP sections are *internal plugins*
//     contributing to the same slot — `TuiPluginEntry.source` includes "internal" — not fixed chrome,
//     which is why the slot is right and only the order was wrong.
//   * 450 places the panel after them. The registry sorts ascending from a default of 0, and 100 was
//     not enough: the host's sections sit somewhere between. 450 is the value the predecessor used,
//     which is the only empirical evidence available for where those sections land.
export const SLOT = "sidebar_content";
export const ORDER = 450;

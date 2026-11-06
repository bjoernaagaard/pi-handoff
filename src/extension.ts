import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CUSTOM_TYPES, findAnchor } from "./records.ts";
import type { AnchorRecord } from "./records.ts";

export default function piHandoff(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    const isFreshStart = event.reason === "startup" || event.reason === "new";

    if (isFreshStart && !findAnchor(ctx.sessionManager.getEntries())) {
      const anchor: AnchorRecord = {
        createdAt: new Date().toISOString(),
        version: 1,
      };

      pi.appendEntry(CUSTOM_TYPES.anchor, anchor);
    }

    ctx.ui.notify("pi-handoff loaded", "info");
  });
}

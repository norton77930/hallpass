import type { ReactElement } from "react";
import type { SettingsRoute } from "../routes.js";
import { OutsideAgents } from "./OutsideAgents.js";
import { RememberedMoves, SiteRows } from "./SiteRows.js";
import { UploadFolders } from "./UploadFolders.js";

/** 024 FR-385: Sites & permissions - outside agents, then sites (with what was allowed for good), then upload folders. */
export function SitesSection(props: { route: SettingsRoute }): ReactElement {
  return (
    <div className="stack narrow" data-section-body="sites">
      <OutsideAgents />
      <SiteRows route={props.route} />
      <RememberedMoves />
      <UploadFolders />
    </div>
  );
}

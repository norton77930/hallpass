import { useId, type ReactElement } from "react";
import { folderName } from "../../side-panel/agent/conversation/folder-name.js";
import { useSettings } from "../context.js";

/**
 * 024 FR-385, D-024-21: the folders agents may upload files from. The list is the helper's (it lives in
 * its config file), so a helper that has not reported it is told as such, not shown as empty. There is
 * Remove and nothing to add: a folder gets onto the list when the owner agrees to an agent's upload
 * request from it, so the page says so rather than offering a picker the helper could not honour.
 */
export function UploadFolders(): ReactElement {
  const { state, t, run, notify } = useSettings();
  const headingId = useId();
  const roots = state.uploadRoots;
  return (
    <section className="blk" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("settings.uploads.title")}</h3>
      <p className="meta">{t("settings.uploads.desc")}</p>
      {roots === undefined ? (
        <p className="note info" role="status">
          {t("settings.uploads.unavailable")}
        </p>
      ) : (
        <>
          {roots.preserved !== undefined ? (
            <p className="note warn">{t("settings.uploads.preserved", { name: roots.preserved })}</p>
          ) : roots.malformed === true ? (
            <p className="note warn">{t("settings.uploads.malformed")}</p>
          ) : null}
          {(roots.notRecorded ?? []).map((root) => (
            <p key={root} className="note warn" data-not-recorded={root}>
              {t("settings.uploads.notRecorded", { folder: folderName(root) })}
            </p>
          ))}
          {roots.roots.length === 0 ? (
            <p className="empty">{t("settings.uploads.empty")}</p>
          ) : (
            <ul className="site-list">
              {roots.roots.map((root) => (
                <li key={root} className="row-item" data-upload-root={root}>
                  <span className="grow">
                    <span className="root-name">{folderName(root)}</span>
                    <code title={root}>{root}</code>
                  </span>
                  <button
                    type="button"
                    className="btn quiet"
                    aria-label={t("settings.uploads.removeLabel", { folder: folderName(root) })}
                    onClick={() => {
                      void run({ type: "ui.agent.upload-root-clear", payload: { root } }, () =>
                        notify(t("settings.uploads.removed", { folder: folderName(root) })),
                      );
                    }}
                  >
                    {t("settings.uploads.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="meta">{t("settings.uploads.addedWhenAsked")}</p>
          {/* 014 FR-191 (the panel's T606 B2 line): where the list file is, for an owner who edits it
              by hand - a fact about their machine shown to them, and in nothing the page copies out. */}
          <p className="meta upload-list-path" title={roots.path}>
            {t("settings.uploads.listPath", { path: roots.path })}
          </p>
        </>
      )}
    </section>
  );
}

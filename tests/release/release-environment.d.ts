export type ReleaseEnvironment = {
  HALLPASS_E2E: "1";
  CHROME_CURRENT_PATH: string;
  CHROME_PREVIOUS_PATH: string;
  CHROME_CURRENT_MAJOR: string;
  CHROME_PREVIOUS_MAJOR: string;
};

export type ReleaseMatrixProfile = {
  channel: "current" | "previous";
  major: string;
  locale: "en-US" | "zh-TW";
  executablePath: string;
};

export declare function parseBrowserMajor(productVersion: string): string | undefined;

export declare function releaseMatrixProfiles(
  release: ReleaseEnvironment,
): ReleaseMatrixProfile[];

export declare function validateReleaseEnvironment(
  source: NodeJS.ProcessEnv,
  fileExists?: (path: string) => boolean,
  readMajor?: (path: string) => string | undefined,
):
  | { ok: true; value: ReleaseEnvironment }
  | { ok: false; reason: string };

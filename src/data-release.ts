import dataRelease from "../data-release.json";

export const dataReleaseRepository = "YoriJP/yori-dict";
export const dataReleaseVersion = dataRelease.version;
export const dataReleaseTag = `data-${dataReleaseVersion}`;
export const dataReleaseUrl =
  `https://github.com/${dataReleaseRepository}/releases/tag/${dataReleaseTag}`;

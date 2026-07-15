export const requireReleaseTag = (tag: string | undefined, version: string): void => {
  const expectedTag = `v${version}`;

  if (tag !== expectedTag) {
    throw new Error(`Tag ${tag ?? "<missing>"} does not match package version ${version}.`);
  }
};

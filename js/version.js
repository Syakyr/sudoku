/**
 * Single source of truth for the version shown in the UI.
 *
 * The git tag is authoritative, NOT package.json -- that has been sitting at
 * 1.0.0 while releases went out as v0.2.x, so reading it would be worse than
 * useless. This file holds the last released version and is overwritten from
 * the tag by CI during the APK build, so a packaged app can never display a
 * version that disagrees with what it actually shipped.
 *
 * For the rolling PWA channel the committed value below is what is shown: the
 * most recent release the deployed code corresponds to.
 */
export const APP_VERSION = '0.2.3';

/** Display form, with the leading "v" the tags carry. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

'use strict';
/**
 * Optional notarization hook for electron-builder.
 *
 * To enable:
 *   1. npm install --save-dev @electron/notarize
 *   2. In electron-builder.yml, uncomment:  afterSign: scripts/notarize.js
 *   3. Export credentials before building:
 *        export APPLE_ID="you@example.com"
 *        export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
 *        export APPLE_TEAM_ID="ABCDE12345"
 *
 * Notarization only makes sense for signed builds (a valid Developer ID
 * Application identity). Unsigned local builds skip this automatically.
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set; skipping notarization.');
    return;
  }

  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;

  console.log(`[notarize] Notarizing ${appName}.app ...`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
  console.log('[notarize] Done.');
};

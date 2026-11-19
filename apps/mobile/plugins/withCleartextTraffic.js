/**
 * Expo's debug manifest sets `android:usesCleartextTraffic="true"`, but the release manifest does not.
 * The pilot API runs over plain HTTP (`http://10.0.2.2:8787` on the emulator), so a release APK built
 * without this opt-in shows "Cannot reach the server" for every request: Android 9+ blocks cleartext.
 *
 * This plugin turns the opt-in on for release builds too. It is deliberately narrow: it exists so the
 * pilot build can talk to the local development API. Remove it once the API is served over HTTPS.
 */
const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("withCleartextTraffic: no <application> element in AndroidManifest.xml");
    }
    application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
};

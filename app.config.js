/**
 * app.config.js — extends app.json at build time.
 * Injects the Google Maps Android API key (react-native-maps needs it in the
 * AndroidManifest; without it MapView renders blank tiles). The key comes from
 * EXPO_PUBLIC_GOOGLE_MAPS_API_KEY (.env locally, .env.production on EAS —
 * see .easignore). Everything else stays defined in app.json.
 */
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    config: {
      ...(config.android?.config ?? {}),
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '',
      },
    },
  },
});

/**
 * Returns a Google OAuth access token for the current user.
 * Used as Bearer token when calling the control plane API.
 */
function getGoogleToken() {
  return ScriptApp.getOAuthToken();
}


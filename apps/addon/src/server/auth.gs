/**
 * Returns a Google OAuth access token for the current user.
 * Used as Bearer token when calling the control plane API.
 */
function getGoogleToken() {
  return ScriptApp.getOAuthToken();
}

/**
 * Smoke-tests whether the current add-on token can call Slides REST directly.
 * Returns only status and short metadata so no document content is exposed.
 */
function smokeTestSlidesRestAccess(presentationId) {
  if (!presentationId) {
    throw new Error('presentationId is required');
  }

  var response = UrlFetchApp.fetch(
    'https://slides.googleapis.com/v1/presentations/' + encodeURIComponent(presentationId),
    {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true
    }
  );

  return {
    status: response.getResponseCode(),
    bodyPreview: response.getContentText().slice(0, 500)
  };
}

/**
 * Creates a temporary user-owned presentation for REST auth smoke tests.
 */
function createSlidesRestSmokeDeck() {
  var presentation = SlidesApp.create('TransLay Slides REST Smoke Test');
  return {
    presentationId: presentation.getId(),
    presentationUrl: presentation.getUrl()
  };
}

/**
 * Trashes a temporary file created during smoke testing.
 */
function trashSmokeTestFile(fileId) {
  if (!fileId) {
    throw new Error('fileId is required');
  }
  DriveApp.getFileById(fileId).setTrashed(true);
}

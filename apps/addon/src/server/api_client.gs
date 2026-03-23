/**
 * Builds request headers with auth token.
 * Includes ngrok-skip-browser-warning for local dev tunneling.
 */
function _authHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'ngrok-skip-browser-warning': '1'
  };
}

/**
 * Fetches entitlement from the control plane.
 * Returns the parsed EntitlementResponse or throws on error.
 */
function fetchEntitlement() {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/entitlement', {
    method: 'get',
    headers: _authHeaders(token),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Creates a translation job via the control plane.
 * @param {Object} jobRequest - CreateJobRequest body
 * @returns {Object} CreateJobResponse
 */
function createJob(jobRequest) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs', {
    method: 'post',
    contentType: 'application/json',
    headers: _authHeaders(token),
    payload: JSON.stringify(jobRequest),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Polls job status from the control plane.
 * @param {string} jobId
 * @returns {Object} JobStatusResponse
 */
function getJobStatus(jobId) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs/' + jobId, {
    method: 'get',
    headers: _authHeaders(token),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Creates a Portal session ticket for upgrade/manage flows.
 * @param {string} redirectPath - Portal page path (e.g., "/pricing")
 * @param {string} reason - Reason for the session (e.g., "upgrade_click")
 * @returns {Object} SessionStartResponse with portal_url
 */
function createPortalTicket(redirectPath, reason) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/session/start', {
    method: 'post',
    contentType: 'application/json',
    headers: _authHeaders(token),
    payload: JSON.stringify({
      redirect_path: redirectPath,
      reason: reason
    }),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Parses API response. Returns parsed JSON on success, throws on error.
 * @param {HTTPResponse} response
 * @returns {Object}
 */
function _handleResponse(response) {
  var code = response.getResponseCode();
  var body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error('Invalid response from server (HTTP ' + code + ')');
  }

  if (code >= 200 && code < 300) {
    return body;
  }

  var errorCode = (body && body.error) ? body.error : 'UNKNOWN';
  var errorMsg = (body && body.message) ? body.message : 'Request failed (HTTP ' + code + ')';
  // Prefix with error code so sidebar can detect specific errors
  // google.script.run failure handlers only receive .message
  throw new Error('[' + errorCode + '] ' + errorMsg);
}

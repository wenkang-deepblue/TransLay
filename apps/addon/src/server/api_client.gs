/**
 * Builds request headers with auth token.
 */
function _authHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token
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
 * Previews quota impact for a Slides translation request.
 * @param {Object} previewRequest - Job quota preview request body
 * @returns {Object} JobQuotaPreviewResponse
 */
function previewJob(previewRequest) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs/preview', {
    method: 'post',
    contentType: 'application/json',
    headers: _authHeaders(token),
    payload: JSON.stringify(previewRequest),
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
 * Requests cooperative pause of an existing translation job.
 * @param {string} jobId
 * @returns {Object} PauseJobResponse
 */
function pauseJob(jobId) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs/' + jobId + '/pause', {
    method: 'post',
    headers: _authHeaders(token),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Requests resuming a paused translation job.
 * @param {string} jobId
 * @returns {Object} ResumeJobResponse
 */
function resumeJob(jobId) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs/' + jobId + '/resume', {
    method: 'post',
    headers: _authHeaders(token),
    muteHttpExceptions: true
  });
  return _handleResponse(response);
}

/**
 * Requests cancellation of an existing translation job.
 * @param {string} jobId
 * @returns {Object} CancelJobResponse
 */
function cancelJob(jobId) {
  var token = getGoogleToken();
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs/' + jobId + '/cancel', {
    method: 'post',
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
 *
 * The control plane always emits a `Retry-After` header (in seconds) on
 * 429 responses. We forward it inside the error message prefix so the
 * sidebar — which can only observe `error.message` through
 * `google.script.run.withFailureHandler` — can implement deterministic
 * exponential backoff with jitter without guessing.
 *
 * Prefix grammar:
 *   [<ERROR_CODE>] <message>
 *   [<ERROR_CODE>:retry=<seconds>] <message>
 *
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

  var retryAfterSeconds = _extractRetryAfter(response);
  var prefix = retryAfterSeconds > 0
    ? '[' + errorCode + ':retry=' + retryAfterSeconds + ']'
    : '[' + errorCode + ']';

  if (errorCode === 'QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION') {
    throw new Error(prefix + ' ' + errorMsg + ' ' + JSON.stringify(body));
  }

  throw new Error(prefix + ' ' + errorMsg);
}

/**
 * Reads the Retry-After header (seconds) in a case-insensitive manner.
 * Returns 0 when the header is absent or malformed.
 * @param {HTTPResponse} response
 * @returns {number}
 */
function _extractRetryAfter(response) {
  try {
    var headers = response.getAllHeaders();
    if (!headers) {
      return 0;
    }
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) &&
          String(key).toLowerCase() === 'retry-after') {
        var raw = headers[key];
        // GAS may surface duplicate headers as arrays; take the first.
        if (Array.isArray(raw)) {
          raw = raw[0];
        }
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
          // Keep client-side handling aligned with the server-side max window.
          return Math.min(parsed, 3600);
        }
      }
    }
  } catch (e) {
    // Header inspection is best-effort; fall through to default backoff.
  }
  return 0;
}

var DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
var DRIVE_PRESENTATION_MIME_TYPE = 'application/vnd.google-apps.presentation';

function driveApiRequest(path, options) {
  var request = {
    method: options.method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + getGoogleToken()
    }
  };

  if (options.payload !== undefined) {
    // Keep empty objects valid for Drive endpoints that accept an empty JSON body.
    request.contentType = 'application/json';
    request.payload = JSON.stringify(options.payload);
  }

  var response;
  try {
    response = UrlFetchApp.fetch(DRIVE_API_BASE_URL + path, request);
  } catch (err) {
    var wrapped = new Error(options.operation + ' failed before receiving Drive API response: ' + err.message);
    wrapped.driveOperation = options.operation;
    wrapped.driveStatus = null;
    wrapped.driveReason = 'url_fetch_failed';
    throw wrapped;
  }

  return parseDriveApiResponse(response, options.operation);
}

function parseDriveApiResponse(response, operation) {
  var code = response.getResponseCode();
  var text = response.getContentText();
  var body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw buildDriveApiError(operation, code, {
        status: 'INVALID_JSON',
        message: 'Drive API response was not valid JSON.'
      });
    }
  }

  if (code >= 200 && code < 300) {
    return body;
  }

  var error = body && body.error ? body.error : {};
  throw buildDriveApiError(operation, code, error);
}

function buildDriveApiError(operation, httpStatus, error) {
  var reason = extractDriveApiReason(error);
  var message = error.message || 'Unknown Drive API error';
  var err = new Error('[DRIVE_REASON:' + reason + '] ' + operation + ' failed (HTTP ' + httpStatus + '): ' + message);
  err.driveOperation = operation;
  err.driveStatus = httpStatus;
  err.driveReason = reason;
  err.driveErrorStatus = error.status || null;
  return err;
}

function extractDriveApiReason(error) {
  if (error && error.errors && error.errors.length && error.errors[0].reason) {
    return error.errors[0].reason;
  }
  if (error && error.status) {
    return error.status;
  }
  return 'unknown';
}

function assertActivePresentationDriveFileAccess() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  var file = driveApiRequest(
    '/files/' + encodeURIComponent(presentation.getId()) +
      '?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canCopy,canShare)',
    {
      method: 'get',
      operation: 'Drive active file access check'
    }
  );

  if (file.id !== presentation.getId()) {
    throw new Error('Drive active file access check returned a different file id');
  }
  if (file.mimeType !== DRIVE_PRESENTATION_MIME_TYPE) {
    throw new Error('The active file is not a Google Slides™ presentation');
  }
  if (!file.capabilities || !file.capabilities.canEdit) {
    throw new Error('You need edit access to translate this presentation');
  }
  if (!file.capabilities.canCopy) {
    throw new Error('This presentation cannot be copied by your account');
  }
  if (!file.capabilities.canShare) {
    throw new Error('This file cannot be shared with TransLay worker access. Ask the owner to allow sharing or make a copy you own.');
  }

  return {
    documentId: file.id,
    documentName: file.name,
    canShare: true
  };
}

function getPreferredParentFolderIdBestEffort(sourceId) {
  try {
    var file = driveApiRequest(
      '/files/' + encodeURIComponent(sourceId) + '?supportsAllDrives=true&fields=parents',
      {
        method: 'get',
        operation: 'Drive parent folder lookup'
      }
    );
    if (file.parents && file.parents.length) {
      return file.parents[0];
    }
  } catch (err) {
    console.warn('Drive parent folder lookup failed; copying to My Drive root: ' + err.message);
  }
  return null;
}

function copyPresentationFile(sourceId, copyName) {
  var payload = { name: copyName };
  var parentId = getPreferredParentFolderIdBestEffort(sourceId);
  if (parentId) {
    payload.parents = [parentId];
  }

  try {
    return copyPresentationFileWithPayload_(sourceId, payload);
  } catch (err) {
    if (payload.parents) {
      console.warn('Drive copy into source folder failed; retrying My Drive root: ' + err.message);
      try {
        return copyPresentationFileWithPayload_(sourceId, { name: copyName });
      } catch (rootErr) {
        throw attachDriveCopyRetryContext_(rootErr, err);
      }
    }
    throw err;
  }
}

function attachDriveCopyRetryContext_(rootErr, parentErr) {
  var parentReason = parentErr.driveReason || 'unknown';
  var parentStatus = parentErr.driveStatus === null || parentErr.driveStatus === undefined
    ? 'n/a'
    : String(parentErr.driveStatus);
  rootErr.message = rootErr.message + ' Same-folder copy previously failed (HTTP ' +
    parentStatus + ' / ' + parentReason + '): ' + parentErr.message;
  rootErr.driveParentRetryStatus = parentErr.driveStatus || null;
  rootErr.driveParentRetryReason = parentReason;
  return rootErr;
}

function copyPresentationFileWithPayload_(sourceId, payload) {
  var copy = driveApiRequest(
    '/files/' + encodeURIComponent(sourceId) + '/copy?supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'post',
      operation: 'Drive copy file',
      payload: payload
    }
  );
  if (!copy || !copy.id) {
    throw new Error('Drive copy file returned no file id');
  }
  return {
    documentId: copy.id,
    documentUrl: copy.webViewLink || ('https://docs.google.com/presentation/d/' + copy.id + '/edit')
  };
}

function grantWorkerAccess(documentId) {
  var permission = driveApiRequest(
    '/files/' + encodeURIComponent(documentId) +
      '/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id',
    {
      method: 'post',
      operation: 'Drive permission grant',
      payload: {
        type: 'user',
        role: 'writer',
        emailAddress: WORKER_SERVICE_ACCOUNT_EMAIL
      }
    }
  );

  if (!permission || !permission.id) {
    throw new Error('Drive permission grant returned no permission id');
  }
  return permission.id;
}

function findWorkerPermissionId(documentId) {
  var result = driveApiRequest(
    '/files/' + encodeURIComponent(documentId) +
      '/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress)',
    {
      method: 'get',
      operation: 'Drive permission lookup'
    }
  );
  var permissions = result.permissions || [];
  for (var i = 0; i < permissions.length; i++) {
    if (permissions[i].emailAddress === WORKER_SERVICE_ACCOUNT_EMAIL) {
      return permissions[i].id;
    }
  }
  return null;
}

function revokeWorkerPermission(documentId, permissionId) {
  if (!documentId || !permissionId) {
    return { ok: true, skipped: true };
  }

  driveApiRequest(
    '/files/' + encodeURIComponent(documentId) +
      '/permissions/' + encodeURIComponent(permissionId) +
      '?supportsAllDrives=true',
    {
      method: 'delete',
      operation: 'Drive permission revoke'
    }
  );

  return { ok: true, skipped: false };
}

function trashDriveFile(documentId) {
  driveApiRequest(
    '/files/' + encodeURIComponent(documentId) + '?supportsAllDrives=true&fields=id,trashed',
    {
      method: 'patch',
      operation: 'Drive trash file',
      payload: {
        trashed: true
      }
    }
  );
}

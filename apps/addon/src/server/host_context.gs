/**
 * Detects the host application type and returns context info.
 * Returns { hostType, documentId, documentName } or null if unsupported.
 */
function getHostContext() {
  try {
    var presentation = SlidesApp.getActivePresentation();
    if (presentation) {
      return {
        hostType: HOST_TYPE_SLIDES,
        documentId: presentation.getId(),
        documentName: presentation.getName()
      };
    }
  } catch (e) {
    console.log('Not in Slides context: ' + e.message);
  }

  try {
    var document = DocumentApp.getActiveDocument();
    if (document) {
      return {
        hostType: HOST_TYPE_DOCS,
        documentId: document.getId(),
        documentName: document.getName()
      };
    }
  } catch (e) {
    console.log('Not in Docs context: ' + e.message);
  }

  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet) {
      return {
        hostType: HOST_TYPE_SHEETS,
        documentId: spreadsheet.getId(),
        documentName: spreadsheet.getName()
      };
    }
  } catch (e) {
    console.log('Not in Sheets context: ' + e.message);
  }

  return null;
}

/**
 * Returns the total number of slides in the current presentation.
 * Throws on error instead of returning fake 0 (C6).
 */
function getSlideCount() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }
  return presentation.getSlides().length;
}

/**
 * Returns the 1-based index of the currently selected slide.
 * Falls back to 1 only if selection API is unavailable (not on error).
 */
function getCurrentSlideIndex() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }
  var selection = presentation.getSelection();
  if (!selection) return 1;
  var page = selection.getCurrentPage();
  if (!page) return 1;
  var slides = presentation.getSlides();
  for (var i = 0; i < slides.length; i++) {
    if (slides[i].getObjectId() === page.getObjectId()) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Returns sheet names for Sheets context.
 */
function getSheetNames() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return [];
  return spreadsheet.getSheets().map(function(s) { return s.getName(); });
}

/**
 * Grants the worker service account editor access to the currently open
 * presentation so backend extraction/write-back can access user-selected
 * test copies without any manual sharing step.
 */
function ensureCurrentPresentationWorkerAccess() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  try {
    grantWorkerAccess(presentation.getId());
  } catch (err) {
    throw new Error('Failed to grant worker access to the current presentation: ' + err.message);
  }
}

/**
 * Creates a user-owned copy of the active presentation and grants the worker
 * service account editor access so backend write-back can target this file.
 *
 * OAuth note: this flow intentionally keeps the broader Drive scope because
 * Apps Script must copy the active source file and mutate ACLs on the
 * user-owned destination file. The production path uses Drive REST first
 * because DriveApp can return opaque service errors for some Slides files;
 * DriveApp remains a fallback. Real-environment validation showed that
 * drive.file is insufficient for this combination in the Slides container
 * context, so full Drive access is the minimum scope that preserves the
 * production create_new_file workflow.
 *
 * Even with that scope, this code path only touches the currently active
 * presentation and the freshly copied destination file.
 * Returns the copied presentation ID and URL.
 */
var DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';

function driveApiRequest(path, options) {
  var request = {
    method: options.method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + getGoogleToken()
    }
  };

  if (options.payload) {
    request.contentType = 'application/json';
    request.payload = JSON.stringify(options.payload);
  }

  var response = UrlFetchApp.fetch(DRIVE_API_BASE_URL + path, request);
  var code = response.getResponseCode();
  var text = response.getContentText();
  var body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(options.operation + ' failed with invalid Drive API response (HTTP ' + code + ')');
    }
  }

  if (code >= 200 && code < 300) {
    return body;
  }

  var error = body && body.error ? body.error : {};
  var details = [];
  if (error.status) {
    details.push(error.status);
  }
  if (error.errors && error.errors.length && error.errors[0].reason) {
    details.push(error.errors[0].reason);
  }
  if (error.message) {
    details.push(error.message);
  }
  throw new Error(options.operation + ' failed (HTTP ' + code + '): ' + (details.join(' / ') || 'Unknown Drive API error'));
}

function grantWorkerAccess(documentId) {
  try {
    driveApiRequest(
      '/files/' + encodeURIComponent(documentId) + '/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id',
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
    return;
  } catch (apiErr) {
    console.warn('Drive API permission grant failed, falling back to DriveApp: ' + apiErr.message);
  }

  DriveApp.getFileById(documentId).addEditor(WORKER_SERVICE_ACCOUNT_EMAIL);
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

function copyPresentationFileViaDriveApi(sourceId, copyName) {
  var copy = driveApiRequest(
    '/files/' + encodeURIComponent(sourceId) + '/copy?supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'post',
      operation: 'Drive copy file',
      payload: {
        name: copyName
      }
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

function getFirstParentFolderBestEffort(sourceFile) {
  try {
    var parents = sourceFile.getParents();
    if (parents.hasNext()) {
      return parents.next();
    }
  } catch (err) {
    console.warn('Could not inspect source presentation parent folder: ' + err.message);
  }
  return null;
}

function copyPresentationFileViaDriveApp(sourceId, copyName) {
  var sourceFile = DriveApp.getFileById(sourceId);
  var parentFolder = getFirstParentFolderBestEffort(sourceFile);
  var copiedFile;
  if (parentFolder) {
    try {
      copiedFile = sourceFile.makeCopy(copyName, parentFolder);
      return {
        documentId: copiedFile.getId(),
        documentUrl: 'https://docs.google.com/presentation/d/' + copiedFile.getId() + '/edit'
      };
    } catch (err) {
      console.warn('Could not copy presentation into source folder, falling back to My Drive root: ' + err.message);
    }
  }

  copiedFile = sourceFile.makeCopy(copyName);
  return {
    documentId: copiedFile.getId(),
    documentUrl: 'https://docs.google.com/presentation/d/' + copiedFile.getId() + '/edit'
  };
}

function copyPresentationFile(sourceId, copyName) {
  try {
    return copyPresentationFileViaDriveApi(sourceId, copyName);
  } catch (apiErr) {
    console.warn('Drive API copy failed, falling back to DriveApp: ' + apiErr.message);
  }

  return copyPresentationFileViaDriveApp(sourceId, copyName);
}

function prepareOutputPresentation(copyLabel) {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  var sourceId = presentation.getId();
  var sourceName = presentation.getName();
  var copyName = sourceName + ' (' + copyLabel + ')';
  var copiedFile = copyPresentationFile(sourceId, copyName);

  try {
    grantWorkerAccess(copiedFile.documentId);
  } catch (err) {
    try {
      trashDriveFile(copiedFile.documentId);
    } catch (cleanupErr) {
      console.error('Failed to trash copied presentation: ' + cleanupErr.message);
    }
    throw new Error('Failed to grant worker access to the copied presentation: ' + err.message);
  }

  return copiedFile;
}

/**
 * Deletes a previously prepared output presentation when job submission fails
 * before the backend accepts the task.
 */
function cleanupPreparedPresentation(documentId) {
  if (!documentId) return;

  try {
    trashDriveFile(documentId);
  } catch (err) {
    console.error('Failed to cleanup prepared presentation: ' + err.message);
  }
}

/**
 * Revokes the worker service account's editor access from a document
 * after job completion, failure, or cancellation. Best-effort: failures
 * are logged but never surfaced to the user.
 */
function revokeWorkerAccess(documentId) {
  if (!documentId) return;

  try {
    DriveApp.getFileById(documentId).removeEditor(WORKER_SERVICE_ACCOUNT_EMAIL);
  } catch (err) {
    console.log('Could not revoke worker access from ' + documentId + ': ' + err.message);
  }
}

/**
 * Revokes worker access from both source and target documents after job ends.
 * Skips revocation if both IDs are the same (append_in_file mode).
 */
function revokeWorkerAccessForJob(sourceDocumentId, targetDocumentId) {
  revokeWorkerAccess(sourceDocumentId);
  if (targetDocumentId && targetDocumentId !== sourceDocumentId) {
    revokeWorkerAccess(targetDocumentId);
  }
}

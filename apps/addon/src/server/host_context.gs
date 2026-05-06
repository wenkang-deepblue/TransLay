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
 * Returns the Drive permission id for Phase 4 persistence wiring; current
 * sidebar callers still ignore this value until the job contract is expanded.
 */
function ensureCurrentPresentationWorkerAccess() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  try {
    var access = assertActivePresentationDriveFileAccess();
    return {
      documentId: access.documentId,
      documentName: access.documentName,
      sourceWorkerPermissionId: grantWorkerAccess(access.documentId)
    };
  } catch (err) {
    throw new Error('Failed to grant worker access to the current presentation: ' + err.message);
  }
}

/**
 * Creates a user-owned copy of the active presentation and grants the worker
 * service account editor access so backend write-back can target this file.
 *
 * This path only touches the currently active presentation and the freshly
 * copied destination file through the Drive REST adapter.
 * Returns the copied presentation ID, URL, and target worker permission id.
 * The permission id is intentionally exposed now so Phase 4/6 can persist and
 * submit it without changing this Drive orchestration again.
 */
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
    copiedFile.targetWorkerPermissionId = grantWorkerAccess(copiedFile.documentId);
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
 * Cleans up source and target Drive preparation when submission stops before
 * the backend accepts the job. Best-effort and safe to call repeatedly.
 */
function cleanupPreparedTranslationSubmission(sourceDocumentId, sourcePermissionId, targetDocumentId, targetPermissionId, targetWasCopiedByAddon) {
  if (targetDocumentId && targetPermissionId) {
    try {
      revokeWorkerPermission(targetDocumentId, targetPermissionId);
    } catch (err) {
      console.error('Failed to revoke prepared target worker permission: ' + err.message);
    }
  }

  if (targetDocumentId && targetWasCopiedByAddon === true) {
    try {
      trashDriveFile(targetDocumentId);
    } catch (err) {
      console.error('Failed to trash prepared target presentation: ' + err.message);
    }
  } else if (targetDocumentId) {
    console.warn('Skipped prepared target trash because add-on copy ownership was not confirmed.');
  }

  if (sourceDocumentId && sourcePermissionId) {
    try {
      revokeWorkerPermission(sourceDocumentId, sourcePermissionId);
    } catch (err) {
      console.error('Failed to revoke prepared source worker permission: ' + err.message);
    }
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
    var permissionId = findWorkerPermissionId(documentId);
    if (!permissionId) {
      console.log('No worker access permission found for ' + documentId);
      return;
    }
    revokeWorkerPermission(documentId, permissionId);
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

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
 * Verifies that the sidebar is running in an active Slides presentation for a
 * user-OAuth-only job. The Add-on must not grant worker service-account access.
 */
function ensureCurrentPresentationReadyForUserOauthJob() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  try {
    presentation.getSlides();
    return {
      documentId: presentation.getId(),
      documentName: presentation.getName(),
      sourceWorkerPermissionId: null,
      accessMode: 'user_oauth_only'
    };
  } catch (err) {
    console.warn('Failed to read the current presentation for translation.');
    throw new Error('Failed to read the current presentation for translation');
  }
}

/**
 * Creates a user-owned copy of the active presentation through Slides APIs.
 */
function prepareOutputPresentation(copyLabel) {
  var source = SlidesApp.getActivePresentation();
  if (!source) {
    throw new Error('No active presentation found');
  }

  try {
    var target = createPresentationCopyWithSlidesApp_(source, copyLabel);
    return {
      documentId: target.getId(),
      documentUrl: target.getUrl(),
      targetWorkerPermissionId: null,
      accessMode: 'user_oauth_only'
    };
  } catch (err) {
    console.warn('Failed to prepare the new presentation.');
    throw new Error('Failed to prepare the new presentation');
  }
}

function createPresentationCopyWithSlidesApp_(source, copyLabel) {
  var target = SlidesApp.create(source.getName() + ' (' + copyLabel + ')');
  var defaultSlides = target.getSlides();
  for (var i = defaultSlides.length - 1; i >= 0; i--) {
    defaultSlides[i].remove();
  }

  var sourceSlides = source.getSlides();
  for (var s = 0; s < sourceSlides.length; s++) {
    target.appendSlide(sourceSlides[s]);
  }

  target.saveAndClose();
  return SlidesApp.openById(target.getId());
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

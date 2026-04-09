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
    DriveApp.getFileById(presentation.getId()).addEditor(WORKER_SERVICE_ACCOUNT_EMAIL);
  } catch (err) {
    throw new Error('Failed to grant worker access to the current presentation.');
  }
}

/**
 * Creates a user-owned copy of the active presentation and grants the worker
 * service account editor access so backend write-back can target this file.
 *
 * OAuth note: this flow intentionally keeps the broader Drive scope because
 * Apps Script must read the active source file via DriveApp.getFileById(),
 * create a sibling copy with inherited parent placement, and then mutate ACLs
 * with addEditor() on that user-owned file. Real-environment validation showed
 * that drive.file is insufficient for this combination in the Slides container
 * context, so full Drive access is the minimum scope that preserves the
 * production create_new_file workflow.
 *
 * Even with that scope, this code path only touches the currently active
 * presentation and the freshly copied destination file.
 * Returns the copied presentation ID and URL.
 */
function prepareOutputPresentation(copyLabel) {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }

  var sourceId = presentation.getId();
  var sourceName = presentation.getName();
  var copyName = sourceName + ' (' + copyLabel + ')';
  var sourceFile = DriveApp.getFileById(sourceId);
  var parents = sourceFile.getParents();
  var copiedFile;

  if (parents.hasNext()) {
    copiedFile = sourceFile.makeCopy(copyName, parents.next());
  } else {
    copiedFile = sourceFile.makeCopy(copyName);
  }

  try {
    copiedFile.addEditor(WORKER_SERVICE_ACCOUNT_EMAIL);
  } catch (err) {
    try {
      copiedFile.setTrashed(true);
    } catch (cleanupErr) {
      console.error('Failed to trash copied presentation: ' + cleanupErr.message);
    }
    throw new Error('Failed to grant worker access to the copied presentation.');
  }

  return {
    documentId: copiedFile.getId(),
    documentUrl: 'https://docs.google.com/presentation/d/' + copiedFile.getId() + '/edit'
  };
}

/**
 * Deletes a previously prepared output presentation when job submission fails
 * before the backend accepts the task.
 */
function cleanupPreparedPresentation(documentId) {
  if (!documentId) return;

  try {
    DriveApp.getFileById(documentId).setTrashed(true);
  } catch (err) {
    console.error('Failed to cleanup prepared presentation: ' + err.message);
  }
}

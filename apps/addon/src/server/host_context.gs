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
 * Throws when the current slide cannot be determined.
 */
function getCurrentSlideIndex() {
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('No active presentation found');
  }
  var selection = presentation.getSelection();
  if (!selection) {
    throw new Error('No current slide selection found');
  }
  var page = selection.getCurrentPage();
  if (!page) {
    throw new Error('No current slide page found');
  }
  var slides = presentation.getSlides();
  for (var i = 0; i < slides.length; i++) {
    if (slides[i].getObjectId() === page.getObjectId()) {
      return i + 1;
    }
  }
  throw new Error('Current slide is not part of the active presentation');
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

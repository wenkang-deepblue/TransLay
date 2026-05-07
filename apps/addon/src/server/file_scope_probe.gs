var TRANSLAY_DRIVE_FILE_SCOPE_LOG_PREFIX = '[translay-drive-file-scope]';

function buildTransLaySlidesHomepage(e) {
  return [buildTransLaySlidesEntryCard_(null)];
}

function requestTransLayFileScopeForActiveDocument(e) {
  console.info(TRANSLAY_DRIVE_FILE_SCOPE_LOG_PREFIX + ' requesting active-file drive.file scope');
  return CardService.newEditorFileScopeActionResponseBuilder()
    .requestFileScopeForActiveDocument()
    .build();
}

function onTransLayFileScopeGranted(e) {
  var result = runTransLayDriveFileScopePreflight_(e);
  logTransLayDriveFileScopeResult_(result);
  return [buildTransLaySlidesEntryCard_(result)];
}

function runTransLayDriveAccessCheckAction(e) {
  var result = runTransLayDriveFileScopePreflight_(e);
  logTransLayDriveFileScopeResult_(result);
  var card = buildTransLaySlidesEntryCard_(result);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .setNotification(CardService.newNotification().setText(
      result.ok ? 'Presentation access is ready.' : 'Presentation access needs attention.'
    ))
    .build();
}

function runTransLayDriveFileScopePreflight_(e) {
  var activeFile = getTransLayActiveSlidesFileFromEvent_(e);
  if (!activeFile.id) {
    return {
      ok: false,
      operation: 'Drive active file access check',
      activeDocumentId: null,
      activeDocumentIdSource: activeFile.source,
      returnedDocumentId: null,
      idMatchesActive: false,
      httpStatus: null,
      driveStatus: null,
      driveReason: activeFile.reason,
      message: activeFile.message,
      eventHasFileScopePermission: activeFile.eventHasFileScopePermission
    };
  }

  var path = '/files/' + encodeURIComponent(activeFile.id) +
    '?supportsAllDrives=true&fields=id,mimeType,capabilities(canEdit,canCopy,canShare)';
  var response = transLayDriveApiRequest_(path, {
    method: 'get',
    operation: 'Drive active file access check'
  });
  response.activeDocumentId = activeFile.id;
  response.activeDocumentTitle = activeFile.title;
  response.activeDocumentIdSource = activeFile.source;
  response.eventHasFileScopePermission = activeFile.eventHasFileScopePermission;
  response.idMatchesActive = response.returnedDocumentId === activeFile.id;
  return response;
}

function getTransLayActiveSlidesFileFromEvent_(e) {
  if (e && e.slides) {
    return {
      id: e.slides.id || null,
      title: e.slides.title || null,
      source: 'event.slides',
      eventHasFileScopePermission: e.slides.addonHasFileScopePermission === true,
      reason: e.slides.addonHasFileScopePermission === false ? 'missing_file_scope' : 'event_slides_id_missing',
      message: e.slides.addonHasFileScopePermission === false
        ? 'The add-on has not been granted file access for this presentation yet.'
        : 'The Slides event did not include a presentation ID.'
    };
  }

  return {
    id: null,
    title: null,
    source: 'event.unavailable',
    eventHasFileScopePermission: null,
    reason: 'slides_event_unavailable',
    message: 'The Google Workspace™ Add-on event did not include Slides context.'
  };
}

function transLayDriveApiRequest_(path, options) {
  var response;
  try {
    response = UrlFetchApp.fetch(DRIVE_API_BASE_URL + path, {
      method: options.method,
      muteHttpExceptions: true,
      headers: {
        Authorization: 'Bearer ' + getGoogleToken()
      }
    });
  } catch (err) {
    return {
      ok: false,
      operation: options.operation,
      httpStatus: null,
      driveStatus: null,
      driveReason: 'url_fetch_failed',
      message: err.message
    };
  }

  var code = response.getResponseCode();
  var body = parseTransLayDriveApiJson_(response.getContentText());
  if (code >= 200 && code < 300) {
    return {
      ok: true,
      operation: options.operation,
      returnedDocumentId: body.id || null,
      httpStatus: code,
      driveStatus: null,
      driveReason: null,
      message: 'Drive REST preflight succeeded.',
      mimeType: body.mimeType || null,
      canEdit: Boolean(body.capabilities && body.capabilities.canEdit),
      canCopy: Boolean(body.capabilities && body.capabilities.canCopy),
      canShare: Boolean(body.capabilities && body.capabilities.canShare)
    };
  }

  var error = body && body.error ? body.error : {};
  return {
    ok: false,
    operation: options.operation,
    returnedDocumentId: null,
    httpStatus: code,
    driveStatus: error.status || null,
    driveReason: extractTransLayDriveApiReason_(error),
    message: error.message || 'Unknown Drive API error.'
  };
}

function parseTransLayDriveApiJson_(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      error: {
        status: 'INVALID_JSON',
        message: 'Drive API response was not valid JSON.'
      }
    };
  }
}

function extractTransLayDriveApiReason_(error) {
  if (error && error.errors && error.errors.length && error.errors[0].reason) {
    return error.errors[0].reason;
  }
  if (error && error.status) {
    return error.status;
  }
  return 'unknown';
}

function logTransLayDriveFileScopeResult_(result) {
  console.info(TRANSLAY_DRIVE_FILE_SCOPE_LOG_PREFIX + ' ' + JSON.stringify({
    ok: result.ok,
    operation: result.operation,
    active_document_id: result.activeDocumentId,
    active_document_id_source: result.activeDocumentIdSource || null,
    event_has_file_scope_permission: result.eventHasFileScopePermission === undefined
      ? null
      : result.eventHasFileScopePermission,
    returned_document_id: result.returnedDocumentId,
    id_matches_active: result.idMatchesActive,
    http_status: result.httpStatus,
    drive_status: result.driveStatus,
    drive_reason: result.driveReason,
    mime_type: result.mimeType || null,
    can_edit: result.canEdit === undefined ? null : result.canEdit,
    can_copy: result.canCopy === undefined ? null : result.canCopy,
    can_share: result.canShare === undefined ? null : result.canShare,
    message: result.message
  }));
}

function buildTransLaySlidesEntryCard_(result) {
  var builder = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('TransLay'));
  var section = CardService.newCardSection();

  if (!result) {
    section
      .addWidget(CardService.newTextParagraph().setText(
        'Authorize this presentation, then open TransLay from the editor menu.'
      ))
      .addWidget(CardService.newTextButton()
        .setText('Authorize this presentation')
        .setOnClickAction(CardService.newAction().setFunctionName('requestTransLayFileScopeForActiveDocument')))
      .addWidget(CardService.newTextButton()
        .setText('Check access')
        .setOnClickAction(CardService.newAction().setFunctionName('runTransLayDriveAccessCheckAction')));
    builder.addSection(section);
    return builder.build();
  }

  if (result.ok && result.idMatchesActive && result.canEdit && result.canCopy && result.canShare) {
    section
      .addWidget(CardService.newTextParagraph().setText(
        'Presentation access is ready. Open TransLay from Extensions > TransLay > Open TransLay.'
      ))
      .addWidget(CardService.newTextButton()
        .setText('Check again')
        .setOnClickAction(CardService.newAction().setFunctionName('runTransLayDriveAccessCheckAction')));
    builder.addSection(section);
    return builder.build();
  }

  var message = result.message || 'Presentation access needs attention.';
  if (result.driveReason === 'missing_file_scope') {
    message = 'Authorize this presentation to continue.';
  } else if (result.ok && result.canShare === false) {
    message = 'This file cannot be shared with TransLay worker access. Ask the owner to allow sharing or make a copy you own.';
  }

  section
    .addWidget(CardService.newTextParagraph().setText(message))
    .addWidget(CardService.newTextButton()
      .setText('Authorize this presentation')
      .setOnClickAction(CardService.newAction().setFunctionName('requestTransLayFileScopeForActiveDocument')))
    .addWidget(CardService.newTextButton()
      .setText('Check again')
      .setOnClickAction(CardService.newAction().setFunctionName('runTransLayDriveAccessCheckAction')));
  builder.addSection(section);
  return builder.build();
}

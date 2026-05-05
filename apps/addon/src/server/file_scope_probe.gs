var PHASE1_DRIVE_FILE_SCOPE_PROBE_NAME = 'Phase 1 Drive file-scope probe';
var PHASE1_DRIVE_FILE_SCOPE_PROBE_LOG_PREFIX = '[phase1-drive-file-scope]';

function buildPhase1DriveFileScopeProbeHomepage(e) {
  return [buildPhase1DriveFileScopeProbeCard_(null)];
}

function requestPhase1DriveFileScopeForActiveDocument(e) {
  console.info(PHASE1_DRIVE_FILE_SCOPE_PROBE_LOG_PREFIX + ' requesting active-file drive.file scope');
  return CardService.newEditorFileScopeActionResponseBuilder()
    .requestFileScopeForActiveDocument()
    .build();
}

function onPhase1DriveFileScopeGranted(e) {
  var result = runPhase1DriveFileScopePreflight_(e);
  logPhase1DriveFileScopeProbeResult_(result);
  return [buildPhase1DriveFileScopeProbeCard_(result)];
}

function runPhase1DriveFileScopePreflightAction(e) {
  var result = runPhase1DriveFileScopePreflight_(e);
  logPhase1DriveFileScopeProbeResult_(result);
  var card = buildPhase1DriveFileScopeProbeCard_(result);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .setNotification(CardService.newNotification().setText(
      result.ok ? 'Drive REST preflight succeeded.' : 'Drive REST preflight failed.'
    ))
    .build();
}

function runPhase1DriveFileScopePreflight_(e) {
  var activeFile = getPhase1ActiveSlidesFileFromEvent_(e);
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
  var response = phase1DriveApiRequest_(path, {
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

function getPhase1ActiveSlidesFileFromEvent_(e) {
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

function phase1DriveApiRequest_(path, options) {
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
  var body = parsePhase1DriveApiJson_(response.getContentText());
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
    driveReason: extractPhase1DriveApiReason_(error),
    message: error.message || 'Unknown Drive API error.'
  };
}

function parsePhase1DriveApiJson_(text) {
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

function extractPhase1DriveApiReason_(error) {
  if (error && error.errors && error.errors.length && error.errors[0].reason) {
    return error.errors[0].reason;
  }
  if (error && error.status) {
    return error.status;
  }
  return 'unknown';
}

function buildPhase1DriveFileScopeProbeCard_(result) {
  var builder = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('TransLay').setSubtitle(PHASE1_DRIVE_FILE_SCOPE_PROBE_NAME));

  var intro = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Use this internal probe to validate active-file Drive access for the open Google Slides™ presentation.'
    ))
    .addWidget(CardService.newTextButton()
      .setText('Request active file access')
      .setOnClickAction(CardService.newAction().setFunctionName('requestPhase1DriveFileScopeForActiveDocument')))
    .addWidget(CardService.newTextButton()
      .setText('Run REST preflight')
      .setOnClickAction(CardService.newAction().setFunctionName('runPhase1DriveFileScopePreflightAction')));
  builder.addSection(intro);

  if (result) {
    builder.addSection(buildPhase1DriveFileScopeProbeResultSection_(result));
  }

  return builder.build();
}

function buildPhase1DriveFileScopeProbeResultSection_(result) {
  var statusText = result.ok ? 'PASS' : 'FAIL';
  var section = CardService.newCardSection()
    .setHeader('Latest REST preflight')
    .addWidget(CardService.newKeyValue().setTopLabel('Status').setContent(statusText))
    .addWidget(CardService.newKeyValue().setTopLabel('HTTP status').setContent(String(result.httpStatus || 'n/a')))
    .addWidget(CardService.newKeyValue().setTopLabel('Drive reason').setContent(String(result.driveReason || 'n/a')))
    .addWidget(CardService.newKeyValue().setTopLabel('Active ID source').setContent(String(result.activeDocumentIdSource || 'n/a')))
    .addWidget(CardService.newKeyValue().setTopLabel('Active ID matched').setContent(result.idMatchesActive ? 'yes' : 'no'));

  if (result.ok) {
    section
      .addWidget(CardService.newKeyValue().setTopLabel('Can edit').setContent(result.canEdit ? 'yes' : 'no'))
      .addWidget(CardService.newKeyValue().setTopLabel('Can copy').setContent(result.canCopy ? 'yes' : 'no'))
      .addWidget(CardService.newKeyValue().setTopLabel('Can share').setContent(result.canShare ? 'yes' : 'no'));
  } else {
    section.addWidget(CardService.newTextParagraph().setText(result.message || 'Drive REST preflight failed.'));
  }

  return section;
}

function logPhase1DriveFileScopeProbeResult_(result) {
  console.info(PHASE1_DRIVE_FILE_SCOPE_PROBE_LOG_PREFIX + ' ' + JSON.stringify({
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

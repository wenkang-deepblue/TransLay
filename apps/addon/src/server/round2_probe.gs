function transLayRound2ProbeActiveSlidesContext() {
  transLayRound2ProbeAssertEnabled_();
  var presentation = SlidesApp.getActivePresentation();
  if (!presentation) {
    throw new Error('Round 2 Probe: No active presentation found.');
  }

  var selection = presentation.getSelection();
  var currentPage = selection ? selection.getCurrentPage() : null;
  var slides = presentation.getSlides();
  return {
    ok: true,
    probe: 'Round 2 Probe',
    documentId: presentation.getId(),
    documentName: presentation.getName(),
    slideCount: slides.length,
    currentPageObjectId: currentPage ? currentPage.getObjectId() : null,
    oneSlideRangeExpression: transLayRound2ProbeGetSelectedSlideRange_(presentation, slides, currentPage)
  };
}

function transLayRound2ProbeCreateTargetWithSlidesApp() {
  transLayRound2ProbeAssertEnabled_();
  var source = SlidesApp.getActivePresentation();
  if (!source) {
    throw new Error('Round 2 Probe: No active presentation found.');
  }

  var sourceSlides = source.getSlides();
  var selection = source.getSelection();
  var currentPage = selection ? selection.getCurrentPage() : null;
  var oneSlideRangeExpression = transLayRound2ProbeGetSelectedSlideRange_(source, sourceSlides, currentPage);
  var target = SlidesApp.create(source.getName() + ' (TransLay round 2 probe)');
  var defaultSlides = target.getSlides();
  for (var d = defaultSlides.length - 1; d >= 0; d--) {
    defaultSlides[d].remove();
  }

  for (var i = 0; i < sourceSlides.length; i++) {
    target.appendSlide(sourceSlides[i]);
  }

  target.saveAndClose();
  var reopenedTarget = SlidesApp.openById(target.getId());
  return {
    ok: true,
    probe: 'Round 2 Probe',
    sourceId: source.getId(),
    sourceName: source.getName(),
    sourceSlideCount: sourceSlides.length,
    targetId: reopenedTarget.getId(),
    targetUrl: reopenedTarget.getUrl(),
    targetSlideCount: reopenedTarget.getSlides().length,
    oneSlideRangeExpression: oneSlideRangeExpression
  };
}

function transLayRound2ProbeSubmitAppendJob() {
  transLayRound2ProbeAssertEnabled_();
  var active = transLayRound2ProbeActiveSlidesContext();
  var jobRequest = transLayRound2ProbeBuildJobRequest_(active, 'append_in_file', null);
  var response = createJob(jobRequest);
  return transLayRound2ProbeBuildAcceptedJobResult_('append_in_file', jobRequest, response, null);
}

function transLayRound2ProbeSubmitCreateNewFileJob() {
  transLayRound2ProbeAssertEnabled_();
  var target = transLayRound2ProbeCreateTargetWithSlidesApp();
  var active = {
    documentId: target.sourceId,
    documentName: target.sourceName,
    oneSlideRangeExpression: target.oneSlideRangeExpression
  };
  var jobRequest = transLayRound2ProbeBuildJobRequest_(active, 'create_new_file', target.targetId);
  var response = createJob(jobRequest);
  return transLayRound2ProbeBuildAcceptedJobResult_('create_new_file', jobRequest, response, target);
}

function transLayRound2ProbeUserOauthFailureBehavior() {
  transLayRound2ProbeAssertEnabled_();
  var active = transLayRound2ProbeActiveSlidesContext();
  var jobRequest = transLayRound2ProbeBuildJobRequest_(active, 'append_in_file', null);
  var response = UrlFetchApp.fetch(API_BASE_URL + '/jobs', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer translay-round-2-probe-invalid-user-oauth-token'
    },
    payload: JSON.stringify(jobRequest),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = transLayRound2ProbeParseJsonResponse_(response.getContentText());
  return {
    ok: status >= 400,
    probe: 'Round 2 Probe',
    expectedFailure: status >= 400,
    jobWasAccepted: status >= 200 && status < 300,
    httpStatus: status,
    responseBody: body,
    request: transLayRound2ProbeDescribeJobRequest_(jobRequest),
    failureMode: 'invalid_user_oauth_before_create_job',
    driveAccessOmitted: jobRequest.drive_access === undefined
  };
}

function transLayRound2ProbeBuildJobRequest_(active, outputMode, targetDocumentId) {
  var request = {
    host_type: 'slides',
    document_id: active.documentId,
    document_name: active.documentName,
    source_language_mode: 'auto',
    target_language_input: 'English',
    output_mode: outputMode,
    range_mode: 'custom',
    range_expression: active.oneSlideRangeExpression || transLayRound2ProbeGetOneSlideRangeFallback_(),
    idempotency_key: transLayRound2ProbeBuildIdempotencyKey_(outputMode)
  };
  if (targetDocumentId) {
    request.target_document_id = targetDocumentId;
  }
  return request;
}

function transLayRound2ProbeBuildAcceptedJobResult_(outputMode, jobRequest, response, target) {
  return {
    ok: true,
    probe: 'Round 2 Probe',
    outputMode: outputMode,
    jobId: response.job_id || null,
    response: response,
    request: transLayRound2ProbeDescribeJobRequest_(jobRequest),
    target: target || null,
    driveAccessOmitted: jobRequest.drive_access === undefined
  };
}

function transLayRound2ProbeDescribeJobRequest_(jobRequest) {
  return {
    host_type: jobRequest.host_type,
    document_id: jobRequest.document_id,
    document_name: jobRequest.document_name,
    target_document_id: jobRequest.target_document_id || null,
    source_language_mode: jobRequest.source_language_mode,
    target_language_input: jobRequest.target_language_input,
    output_mode: jobRequest.output_mode,
    range_mode: jobRequest.range_mode,
    range_expression: jobRequest.range_expression,
    idempotency_key: jobRequest.idempotency_key,
    has_drive_access: jobRequest.drive_access !== undefined
  };
}

function transLayRound2ProbeGetSelectedSlideRange_(presentation, slides, currentPage) {
  if (!currentPage) {
    return '1';
  }
  for (var i = 0; i < slides.length; i++) {
    if (slides[i].getObjectId() === currentPage.getObjectId()) {
      return String(i + 1);
    }
  }
  return '1';
}

function transLayRound2ProbeGetOneSlideRangeFallback_() {
  try {
    return String(getCurrentSlideIndex());
  } catch (err) {
    return '1';
  }
}

function transLayRound2ProbeIsEnabled() {
  return transLayRound2ProbeIsEnabled_();
}

function transLayRound2ProbeAssertEnabled_() {
  if (!transLayRound2ProbeIsEnabled_()) {
    throw new Error('Round 2 Probe is disabled.');
  }
}

function transLayRound2ProbeIsEnabled_() {
  try {
    var properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('TRANSLAY_ROUND2_PROBE_ENABLED') !== 'true') {
      return false;
    }

    var allowlistRaw = properties.getProperty('TRANSLAY_ROUND2_PROBE_ALLOWED_EMAILS') || '';
    var allowlist = allowlistRaw.split(',').map(function(email) {
      return email.trim().toLowerCase();
    }).filter(function(email) {
      return email.length > 0;
    });
    if (allowlist.length === 0) {
      return false;
    }

    var userEmail = '';
    try {
      userEmail = Session.getActiveUser().getEmail();
    } catch (err) {
      userEmail = '';
    }
    return allowlist.indexOf(String(userEmail || '').toLowerCase()) !== -1;
  } catch (err) {
    return false;
  }
}

function transLayRound2ProbeBuildIdempotencyKey_(outputMode) {
  return 'round2_probe_' + outputMode + '_' + Utilities.getUuid();
}

function transLayRound2ProbeParseJsonResponse_(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      raw: text
    };
  }
}

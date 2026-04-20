/**
 * Returns the UI object for the current host application.
 * Throws if no supported host is detected (C6).
 */
function _getUi() {
  try { return SlidesApp.getUi(); } catch (e) { /* not Slides */ }
  try { return DocumentApp.getUi(); } catch (e) { /* not Docs */ }
  try { return SpreadsheetApp.getUi(); } catch (e) { /* not Sheets */ }
  return null;
}

/**
 * Runs when the Add-on is installed or the document is opened.
 * Adds the TransLay menu item.
 */
function onOpen() {
  var ui = _getUi();
  if (ui) {
    ui.createAddonMenu()
      .addItem('Open TransLay', 'showSidebar')
      .addToUi();
  } else {
    console.warn('TransLay: No supported host UI detected in onOpen');
  }
}

/**
 * Runs when the Add-on is installed from the Marketplace.
 */
function onInstall() {
  onOpen();
}

/**
 * Opens the TransLay sidebar. Throws if no host UI available (C6).
 */
function showSidebar() {
  var ui = _getUi();
  if (!ui) {
    throw new Error('TransLay requires Google Docs™, Sheets, or Slides.');
  }
  var html = HtmlService.createHtmlOutputFromFile('src/sidebar/index')
    .setTitle('TransLay')
    .setWidth(320);
  ui.showSidebar(html);
}

/**
 * Returns initialization data for the sidebar.
 * Called once when the sidebar loads.
 */
function getInitData() {
  var context = getHostContext();
  var hostType = context ? context.hostType : null;
  var isSupported = hostType !== null && SUPPORTED_HOST_TYPES.indexOf(hostType) !== -1;

  var result = {
    hostType: hostType,
    documentId: context ? context.documentId : null,
    documentName: context ? context.documentName : null,
    logoInlineSvg: TRANSLAY_LOGO_SVG,
    isSupported: isSupported,
    presetLanguages: PRESET_LANGUAGES,
    slideCount: 0,
    currentSlideIndex: 1,
    sheetNames: [],
    entitlementCacheTtl: ENTITLEMENT_CACHE_TTL,
    jobPollIntervalMs: JOB_POLL_INTERVAL_MS
  };

  // C6: getSlideCount/getCurrentSlideIndex now throw on error;
  // catch here so sidebar still loads with defaults
  if (hostType === HOST_TYPE_SLIDES) {
    try {
      result.slideCount = getSlideCount();
    } catch (e) {
      console.error('Failed to get slide count: ' + e.message);
    }
    try {
      result.currentSlideIndex = getCurrentSlideIndex();
    } catch (e) {
      console.error('Failed to get current slide index: ' + e.message);
    }
  } else if (hostType === HOST_TYPE_SHEETS) {
    result.sheetNames = getSheetNames();
  }

  return result;
}

/**
 * Called by sidebar to get the Portal URL for upgrade/manage.
 * @param {string} reason - "upgrade_click" or "manage_subscription"
 * @returns {string} portal_url
 */
function getPortalUrl(reason) {
  var redirectPath = reason === 'manage_subscription' ? '/billing' : '/pricing';
  var ticket = createPortalTicket(redirectPath, reason);
  return ticket.portal_url;
}

/**
 * C7: Idempotency key generation uses google_subject_id from the control plane.
 * The Add-on generates a client-side key for deduplication, but the real
 * idempotency enforcement happens server-side with google_subject_id.
 * We use a stable hash of the request parameters as the key.
 */
function generateIdempotencyKey(hostType, documentId, targetLang, outputMode, rangeExpression, submissionNonce) {
  var rangePart = rangeExpression || 'all';
  var noncePart = submissionNonce || 'stable';
  var raw = hostType + ':' + documentId + ':' + targetLang + ':' + outputMode + ':' + rangePart + ':' + noncePart;
  // Use Utilities.computeDigest for a stable hash, avoiding email dependency
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  var hex = digest.map(function(b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
  return hex;
}

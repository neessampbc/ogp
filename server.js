const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GOOGLE_SHEETS_CREDENTIALS_B64 = process.env.GOOGLE_SHEETS_CREDENTIALS_B64 || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A:K';

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/* =========================================================
   small helpers
   ========================================================= */

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* very small sliding-window limiter — this endpoint fans out to paid Google
   APIs (Places + PageSpeed), so an open public route needs *some* abuse
   ceiling even at MVP scope. Per-IP, per-route, in-memory (fine for a single
   Railway instance; would need a shared store behind multiple instances). */
const RATE_LIMITS = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (RATE_LIMITS.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    RATE_LIMITS.set(key, hits);
    return true;
  }
  hits.push(now);
  RATE_LIMITS.set(key, hits);
  return false;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   Google Places (New) + PageSpeed Insights
   ========================================================= */

async function placesAutocomplete(input, sessionToken) {
  const res = await fetchWithTimeout('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
    },
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ['us'],
    }),
  }, 8000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Autocomplete failed: ${res.status} ${JSON.stringify(data)}`);

  return (data.suggestions || [])
    .filter((s) => s.placePrediction)
    .map((s) => ({
      placeId: s.placePrediction.placeId,
      text: s.placePrediction.text && s.placePrediction.text.text,
      mainText: s.placePrediction.structuredFormat && s.placePrediction.structuredFormat.mainText
        ? s.placePrediction.structuredFormat.mainText.text
        : (s.placePrediction.text && s.placePrediction.text.text),
      secondaryText: s.placePrediction.structuredFormat && s.placePrediction.structuredFormat.secondaryText
        ? s.placePrediction.structuredFormat.secondaryText.text
        : '',
    }));
}

const PLACE_DETAILS_FIELD_MASK = [
  'id', 'displayName', 'rating', 'userRatingCount', 'nationalPhoneNumber',
  'internationalPhoneNumber', 'formattedAddress', 'regularOpeningHours',
  'websiteUri', 'primaryType', 'types', 'businessStatus', 'photos', 'location',
].join(',');

async function placeDetails(placeId, sessionToken) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken || '')}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
    },
  }, 8000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Place Details failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function nearbyCompetitors(location, primaryType, excludePlaceId) {
  if (!location) return [];
  const res = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({
      includedTypes: [primaryType || 'restaurant'],
      maxResultCount: 6,
      locationRestriction: {
        circle: { center: { latitude: location.latitude, longitude: location.longitude }, radius: 1500 },
      },
    }),
  }, 8000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Nearby Search failed: ${res.status} ${JSON.stringify(data)}`);
  return (data.places || [])
    .filter((p) => p.id !== excludePlaceId)
    .slice(0, 3);
}

async function pageSpeedScores(siteUrl) {
  if (!siteUrl) return { seo: null, performance: null, error: 'no_website' };
  try {
    const qs = new URLSearchParams({
      url: siteUrl,
      key: GOOGLE_MAPS_API_KEY,
      strategy: 'MOBILE',
    });
    qs.append('category', 'SEO');
    qs.append('category', 'PERFORMANCE');
    const res = await fetchWithTimeout(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs.toString()}`, {}, 28000);
    const data = await res.json();
    if (!res.ok) throw new Error(`PageSpeed failed: ${res.status} ${JSON.stringify(data)}`);
    const categories = (data.lighthouseResult && data.lighthouseResult.categories) || {};
    return {
      seo: categories.seo ? Math.round(categories.seo.score * 100) : null,
      performance: categories.performance ? Math.round(categories.performance.score * 100) : null,
      error: null,
    };
  } catch (err) {
    return { seo: null, performance: null, error: err.message };
  }
}

/* =========================================================
   Scoring rubric (0-100) — see project plan for the full rationale.
   Delivery-app presence (10 pts of Local listings) has no public API for
   MVP, so it's held at a flat neutral default and flagged in findings for
   manual verification rather than faked as a real signal.
   ========================================================= */

const DELIVERY_APP_DEFAULT_PTS = 5;

function grade(pct) {
  if (pct >= 90) return 'Excellent';
  if (pct >= 75) return 'Good';
  if (pct >= 50) return 'Fair';
  return 'Poor';
}

function computeScore(details, pageSpeed, competitors) {
  const findings = [];

  // Search results /40
  let seoPts = 0;
  let perfPts = 0;
  if (!details.websiteUri) {
    findings.push({ severity: 'high', text: 'No website found on the Google Business Profile — customers searching for a menu or hours have nowhere to land.' });
  } else if (pageSpeed.error) {
    findings.push({ severity: 'medium', text: `Couldn't fully analyze the website (${pageSpeed.error}) — it may be slow, blocking automated tools, or down.` });
  } else {
    seoPts = Math.round((pageSpeed.seo || 0) / 100 * 20);
    perfPts = Math.round((pageSpeed.performance || 0) / 100 * 20);
    if (pageSpeed.seo !== null && pageSpeed.seo < 70) {
      findings.push({ severity: 'medium', text: `Website SEO score is ${pageSpeed.seo}/100 — missing fundamentals are likely keeping it out of search results.` });
    }
    if (pageSpeed.performance !== null && pageSpeed.performance < 70) {
      findings.push({ severity: 'medium', text: `Mobile page speed score is ${pageSpeed.performance}/100 — slow load times drive customers away before the menu loads.` });
    }
  }
  const searchResultsPts = seoPts + perfPts;

  // Guest experience /40
  const rating = details.rating || 0;
  const ratingPts = Math.round((rating / 5) * 20);
  if (rating > 0 && rating < 4.2) {
    findings.push({ severity: 'high', text: `Google rating is ${rating.toFixed(1)}/5 — below the range customers use as a trust cutoff.` });
  }

  const ownReviewCount = details.userRatingCount || 0;
  const competitorCounts = competitors.map((c) => c.userRatingCount || 0).filter((n) => n > 0);
  const avgCompetitorCount = competitorCounts.length
    ? competitorCounts.reduce((a, b) => a + b, 0) / competitorCounts.length
    : 0;
  const reviewRatio = avgCompetitorCount > 0 ? ownReviewCount / avgCompetitorCount : (ownReviewCount > 0 ? 1 : 0);
  const reviewPts = Math.round(Math.min(1, reviewRatio) * 10);
  if (avgCompetitorCount > 0 && ownReviewCount < avgCompetitorCount) {
    findings.push({ severity: 'medium', text: `${ownReviewCount} reviews vs. a nearby average of ${Math.round(avgCompetitorCount)} — fewer reviews than the competition means lower trust at a glance.` });
  }

  const photoCount = (details.photos || []).length;
  const photoPts = Math.min(10, photoCount);
  if (photoCount < 10) {
    findings.push({ severity: 'low', text: `Only ${photoCount} photo${photoCount === 1 ? '' : 's'} on the Google Business Profile — listings with 10+ photos get meaningfully more clicks.` });
  }

  const guestExperiencePts = ratingPts + reviewPts + photoPts;

  // Local listings /20
  let completenessPts = 0;
  if (details.websiteUri) completenessPts += 2; else findings.push({ severity: 'medium', text: 'No website linked on the Google Business Profile.' });
  if (details.nationalPhoneNumber || details.internationalPhoneNumber) completenessPts += 2; else findings.push({ severity: 'medium', text: 'No phone number listed on the Google Business Profile.' });
  const hasHours = details.regularOpeningHours && Array.isArray(details.regularOpeningHours.periods) && details.regularOpeningHours.periods.length > 0;
  if (hasHours) completenessPts += 2; else findings.push({ severity: 'medium', text: 'Business hours are missing or incomplete on Google.' });
  if (details.primaryType) completenessPts += 2; else findings.push({ severity: 'low', text: 'No business category set on the Google Business Profile.' });
  if (details.businessStatus === 'OPERATIONAL') completenessPts += 2; else findings.push({ severity: 'high', text: `Google lists this business status as "${details.businessStatus || 'unknown'}" instead of operational.` });

  findings.push({ severity: 'low', text: 'Delivery app presence (DoorDash/Uber Eats/Grubhub) needs manual verification — not yet automatable.' });
  const deliveryPts = DELIVERY_APP_DEFAULT_PTS;

  const localListingsPts = completenessPts + deliveryPts;

  const total = Math.round(searchResultsPts + guestExperiencePts + localListingsPts);

  const estimatedMonthlyLoss = Math.round(((100 - total) / 100) * 6000 / 50) * 50;

  return {
    total,
    grade: grade(total),
    estimatedMonthlyLoss,
    categories: {
      searchResults: {
        points: searchResultsPts, max: 40, grade: grade((searchResultsPts / 40) * 100),
        metrics: {
          website: details.websiteUri || null,
          seo: { points: seoPts, max: 20, score: (!details.websiteUri || pageSpeed.error) ? null : pageSpeed.seo },
          performance: { points: perfPts, max: 20, score: (!details.websiteUri || pageSpeed.error) ? null : pageSpeed.performance },
          pageSpeedError: details.websiteUri ? (pageSpeed.error || null) : null,
        },
      },
      guestExperience: {
        points: guestExperiencePts, max: 40, grade: grade((guestExperiencePts / 40) * 100),
        metrics: {
          rating: { points: ratingPts, max: 20, value: rating },
          reviews: { points: reviewPts, max: 10, ownCount: ownReviewCount, avgCompetitorCount: avgCompetitorCount > 0 ? Math.round(avgCompetitorCount) : null },
          photos: { points: photoPts, max: 10, count: photoCount },
        },
      },
      localListings: {
        points: localListingsPts, max: 20, grade: grade((localListingsPts / 20) * 100),
        metrics: {
          completeness: {
            points: completenessPts, max: 10,
            website: !!details.websiteUri,
            phone: !!(details.nationalPhoneNumber || details.internationalPhoneNumber),
            hours: hasHours,
            category: !!details.primaryType,
            status: details.businessStatus || 'unknown',
          },
          delivery: { points: deliveryPts, max: 10, note: 'needs manual verification' },
        },
      },
    },
    competitors: competitors.map((c) => ({
      name: c.displayName ? c.displayName.text : '(unnamed)',
      rating: c.rating != null ? c.rating : null,
      userRatingCount: c.userRatingCount || 0,
    })),
    findings,
  };
}

/* human-readable breakdown of every score and metric above — this is what
   lands in the Sheet's "Findings Summary" column, so staff can reply on
   WhatsApp straight from it without re-deriving anything (not just the
   flagged problems the teaser highlights). */
function buildFullReport(score) {
  const lines = [];
  const pct = (n) => (n != null ? `${n}/100` : 'unavailable');

  lines.push(`OVERALL: ${score.total}/100 (${score.grade}) — Est. $${score.estimatedMonthlyLoss.toLocaleString('en-US')}/mo in lost orders`);

  const sr = score.categories.searchResults;
  lines.push('', `SEARCH RESULTS: ${sr.points}/${sr.max} (${sr.grade})`);
  lines.push(`  - Website: ${sr.metrics.website || 'none found'}`);
  if (sr.metrics.website) {
    lines.push(`  - SEO fundamentals: ${sr.metrics.seo.points}/${sr.metrics.seo.max} (Lighthouse SEO score ${pct(sr.metrics.seo.score)})`);
    lines.push(`  - Speed & mobile: ${sr.metrics.performance.points}/${sr.metrics.performance.max} (Lighthouse Performance score ${pct(sr.metrics.performance.score)}, mobile)`);
    if (sr.metrics.pageSpeedError) lines.push(`  - Note: couldn't fully analyze the website (${sr.metrics.pageSpeedError})`);
  }

  const ge = score.categories.guestExperience;
  lines.push('', `GUEST EXPERIENCE: ${ge.points}/${ge.max} (${ge.grade})`);
  lines.push(`  - Rating: ${ge.metrics.rating.points}/${ge.metrics.rating.max} (${ge.metrics.rating.value.toFixed(1)}/5 stars)`);
  lines.push(`  - Review volume: ${ge.metrics.reviews.points}/${ge.metrics.reviews.max} (${ge.metrics.reviews.ownCount.toLocaleString('en-US')} reviews${ge.metrics.reviews.avgCompetitorCount ? ` vs. nearby average of ${ge.metrics.reviews.avgCompetitorCount.toLocaleString('en-US')}` : ''})`);
  lines.push(`  - Photos: ${ge.metrics.photos.points}/${ge.metrics.photos.max} (${ge.metrics.photos.count} photo${ge.metrics.photos.count === 1 ? '' : 's'} on Google Business Profile)`);

  const ll = score.categories.localListings;
  const c = ll.metrics.completeness;
  lines.push('', `LOCAL LISTINGS: ${ll.points}/${ll.max} (${ll.grade})`);
  lines.push(`  - Profile completeness: ${c.points}/${c.max} (Website: ${c.website ? 'yes' : 'no'}, Phone: ${c.phone ? 'yes' : 'no'}, Hours: ${c.hours ? 'yes' : 'no'}, Category: ${c.category ? 'yes' : 'no'}, Status: ${c.status})`);
  lines.push(`  - Delivery app presence: ${ll.metrics.delivery.points}/${ll.metrics.delivery.max} (DoorDash/Uber Eats/Grubhub — ${ll.metrics.delivery.note})`);

  if (score.competitors && score.competitors.length) {
    lines.push('', 'NEARBY COMPETITORS COMPARED:');
    score.competitors.forEach((comp) => {
      lines.push(`  - ${comp.name} — ${comp.rating != null ? comp.rating.toFixed(1) : '?'}★, ${comp.userRatingCount.toLocaleString('en-US')} reviews`);
    });
  }

  if (score.findings && score.findings.length) {
    lines.push('', 'FLAGGED ISSUES:');
    score.findings.forEach((f) => lines.push(`  - ${f.text}`));
  }

  return lines.join('\n');
}

/* =========================================================
   Google Sheets (service account JWT, no googleapis dependency)
   ========================================================= */

let sheetsCredsCache = null;
function sheetsCreds() {
  if (sheetsCredsCache) return sheetsCredsCache;
  if (!GOOGLE_SHEETS_CREDENTIALS_B64) throw new Error('GOOGLE_SHEETS_CREDENTIALS_B64 is not set');
  sheetsCredsCache = JSON.parse(Buffer.from(GOOGLE_SHEETS_CREDENTIALS_B64, 'base64').toString('utf8'));
  return sheetsCredsCache;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signServiceAccountJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), creds.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

let cachedAccessToken = null; // { token, expiresAt }
async function sheetsAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 30000) {
    return cachedAccessToken.token;
  }
  const creds = sheetsCreds();
  const assertion = signServiceAccountJwt(creds);
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, 8000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets auth failed: ${res.status} ${JSON.stringify(data)}`);
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
  return cachedAccessToken.token;
}

async function appendLeadRow(row) {
  if (!GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set');
  const token = await sheetsAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(GOOGLE_SHEET_RANGE)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  }, 10000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${JSON.stringify(data)}`);
  return data.updates && data.updates.updatedRange; // e.g. "Sheet1!A5:K5"
}

async function confirmWhatsappRow(leadRef) {
  const match = /^(.*)!([A-Z]+)(\d+):/.exec(leadRef || '');
  if (!match) throw new Error('Invalid leadRef');
  const sheetName = match[1];
  const row = match[3];
  const token = await sheetsAccessToken();
  const cell = `${sheetName}!K${row}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(cell)}?valueInputOption=USER_ENTERED`;
  const res = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['TRUE']] }),
  }, 8000);
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets update failed: ${res.status} ${JSON.stringify(data)}`);
}

/* =========================================================
   API route handlers
   ========================================================= */

async function handleAutocomplete(req, res, query) {
  if (rateLimited(`autocomplete:${clientIp(req)}`, 30, 60000)) {
    return sendJson(res, 429, { error: 'Too many requests, slow down.' });
  }
  const input = (query.get('input') || '').trim();
  const sessionToken = query.get('sessionToken') || '';
  if (!input) return sendJson(res, 400, { error: 'Missing input' });
  if (!GOOGLE_MAPS_API_KEY) return sendJson(res, 500, { error: 'Server is not configured for search yet.' });
  try {
    const suggestions = await placesAutocomplete(input, sessionToken);
    sendJson(res, 200, { suggestions });
  } catch (err) {
    console.error('autocomplete error', err);
    sendJson(res, 502, { error: 'Search is temporarily unavailable.' });
  }
}

async function handleScan(req, res) {
  if (rateLimited(`scan:${clientIp(req)}`, 10, 60000)) {
    return sendJson(res, 429, { error: 'Too many scans, please wait a minute.' });
  }
  if (!GOOGLE_MAPS_API_KEY) return sendJson(res, 500, { error: 'Server is not configured for scanning yet.' });
  let body;
  try {
    body = await readJsonBody(req, 10_000);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const placeId = (body.placeId || '').trim();
  const sessionToken = body.sessionToken || '';
  if (!placeId) return sendJson(res, 400, { error: 'Missing placeId' });

  try {
    const details = await placeDetails(placeId, sessionToken);
    const competitors = await nearbyCompetitors(details.location, details.primaryType, details.id).catch(() => []);
    const pageSpeed = await pageSpeedScores(details.websiteUri);
    const score = computeScore(details, pageSpeed, competitors);
    score.fullReport = buildFullReport(score);

    sendJson(res, 200, {
      business: {
        placeId: details.id,
        name: details.displayName ? details.displayName.text : '',
        address: details.formattedAddress || '',
        rating: details.rating || null,
        userRatingCount: details.userRatingCount || 0,
        websiteUri: details.websiteUri || null,
      },
      score,
    });
  } catch (err) {
    console.error('scan error', err);
    sendJson(res, 502, { error: 'Could not complete the scan. Please try again.' });
  }
}

function isValidPhone(phone) {
  return /^[0-9+()\-.\s]{7,20}$/.test(phone || '');
}

async function handleLead(req, res) {
  if (rateLimited(`lead:${clientIp(req)}`, 10, 60000)) {
    return sendJson(res, 429, { error: 'Too many requests, please wait a minute.' });
  }
  let body;
  try {
    body = await readJsonBody(req, 20_000);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const name = (body.name || '').trim().slice(0, 200);
  const phone = (body.phone || '').trim().slice(0, 40);
  const businessName = (body.businessName || '').trim().slice(0, 200);
  const placeId = (body.placeId || '').trim().slice(0, 200);
  const score = body.score || {};

  if (!name || !isValidPhone(phone) || !businessName) {
    return sendJson(res, 400, { error: 'Missing or invalid name/phone/business name.' });
  }
  if (!GOOGLE_SHEETS_CREDENTIALS_B64 || !GOOGLE_SHEET_ID) {
    console.error('lead capture attempted but Sheets is not configured');
    return sendJson(res, 500, { error: 'Lead capture is not configured yet.' });
  }

  const findingsSummary = typeof score.fullReport === 'string'
    ? score.fullReport.slice(0, 4000)
    : (Array.isArray(score.findings) ? score.findings.map((f) => f.text).join(' | ').slice(0, 2000) : '');

  const row = [
    new Date().toISOString(),
    name,
    phone,
    businessName,
    placeId,
    score.total != null ? score.total : '',
    score.categories && score.categories.searchResults ? score.categories.searchResults.points : '',
    score.categories && score.categories.guestExperience ? score.categories.guestExperience.points : '',
    score.categories && score.categories.localListings ? score.categories.localListings.points : '',
    findingsSummary,
    'FALSE',
  ];

  try {
    const leadRef = await appendLeadRow(row);
    sendJson(res, 200, { ok: true, leadRef: leadRef || null });
  } catch (err) {
    console.error('lead append error', err);
    sendJson(res, 502, { error: 'Could not save your info. Please try again.' });
  }
}

async function handleLeadConfirm(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 2_000);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (!body.leadRef) return sendJson(res, 400, { error: 'Missing leadRef' });
  try {
    await confirmWhatsappRow(body.leadRef);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('lead confirm error', err);
    sendJson(res, 200, { ok: false }); // best-effort — never block the user's WhatsApp click on this
  }
}

/* =========================================================
   static file serving
   ========================================================= */

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const requested = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));

  if (!requested.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(requested, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fallbackData);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(requested)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* =========================================================
   server
   ========================================================= */

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const query = new URLSearchParams(req.url.split('?')[1] || '');

  if (urlPath === '/api/autocomplete' && req.method === 'GET') return void handleAutocomplete(req, res, query);
  if (urlPath === '/api/scan' && req.method === 'POST') return void handleScan(req, res);
  if (urlPath === '/api/lead' && req.method === 'POST') return void handleLead(req, res);
  if (urlPath === '/api/lead/confirm' && req.method === 'POST') return void handleLeadConfirm(req, res);
  if (urlPath.startsWith('/api/')) return void sendJson(res, 404, { error: 'Not found' });

  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Order Growth Partners listening on port ${PORT}`);
});

#!/usr/bin/env node
// =============================================================================
// sweep.mjs — DC Weekend Events Planner weekly data refresh
//
// Runs the search tracks from PROMPTS.md against the Anthropic Messages API
// (web_search tool), validates/dedups/merges IN CODE per SCHEMA.md, and writes
// events.json. The model's only job is FINDING events; every deterministic
// decision (ids, validation, coercion, dedup, cadence, safety) lives here.
//
// Node >= 18 (global fetch). Zero npm dependencies.
// Env: ANTHROPIC_API_KEY
// Exit codes: 0 = ok (events.json written) · 1 = safety abort (kept last good)
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// (f) Cost guards & tunables
// ---------------------------------------------------------------------------
export const MODEL = "claude-sonnet-5";      // cheaper AND newer than sonnet-4-6
export const WEB_SEARCH_TOOL = "web_search_20260209"; // dynamic-filtering variant
export const MAX_SEARCHES_PER_TRACK = 6;    // web_search max_uses
export const MAX_TOKENS = 16000;            // was 8192; truncation used to kill a whole track
export const MAX_CONTINUES = 5;             // pause_turn continuation cap
export const THEATER_STALE_DAYS = 13;       // (d) tracks 5–7 cadence
export const MIN_NONRECURRING = 8;          // (g) safety floor
export const MAX_TRACK_ERRORS = 2;          // (g) abort if MORE than this errored
export const RETRY_DELAY_MS = 20000;
export const TRACK_CONCURRENCY = 3;       // tracks run in parallel, capped (rate-limit friendly)
export const REQUEST_TIMEOUT_MS = 120000; // abort a single API request if it hangs (2 min)

// Cost reporting (list rates, USD). Used only for the per-run log line.
export const PRICE_IN_PER_MTOK = 2.00;
export const PRICE_OUT_PER_MTOK = 10.00;
export const PRICE_PER_1K_SEARCHES = 10.00;

// Structured outputs (output_config.format) would remove the hand-rolled JSON
// scan below. The request shape is wired up but OFF: it has not been verified
// against a live response that also carries server-side web_search blocks, and
// a 400 here means a Thursday with no refresh. Flip after one manual dispatch.
export const USE_STRUCTURED_OUTPUT = false;

// ---------------------------------------------------------------------------
// Canonical lists — SCHEMA.md, exact strings
// ---------------------------------------------------------------------------
export const CANONICAL_NEIGHBORHOODS = [
  "Capitol Hill",
  "Southwest / The Wharf",
  "Navy Yard / Ballpark",
  "Downtown / National Mall",
  "U Street",
  "H Street NE",
  "Other DC",
  "Worth the Trip"
];

// "free-lowcost" is a derived view, never an assignable category.
export const ASSIGNABLE_CATEGORIES = [
  "outdoor", "music", "theater", "comedy", "museums-culture",
  "arts", "sports-active", "biking", "food-markets", "family-teens"
];

export const THEATER_TRACK_CATEGORIES = ["theater", "music", "comedy"]; // tracks 5–7 own these

// (S1) Every published url must resolve to one of these hosts, or the entry is
// dropped. The model finds events on the open web, so an event's link is the one
// field an outsider can influence: a compromised or spammy source page can talk
// the model into a plausible entry pointing anywhere. Seeded from the domains the
// track prompts name plus every host that appeared in a real run — subdomains of
// a listed host are accepted. An unrecognized host is a log line, not a silent drop.
export const ALLOWED_URL_HOSTS = [
  // roundups / civic / city
  "washington.org", "dc.gov", "250.dc.gov", "dpr.dc.gov", "ddot.dc.gov", "events.dc.gov",
  "dclibrary.org", "dclibrary.libnet.info", "nps.gov", "si.edu", "usbg.gov", "loc.gov",
  "kennedy-center.org", "nationalgeographic.org", "smithsonianmag.com",
  // waterfront / festival / market
  "wharfdc.com", "capitolriverfront.org", "eventsdc.com", "rfkfields.com",
  "easternmarket-dc.org", "easternmarketmainstreet.org", "dcstatefair.org",
  "dcjazzfest.org", "thehotelwashington.com", "trolleytours.com", "chaw.org",
  // biking
  "waba.org", "dcbikeride.com",
  // theater
  "arenastage.org", "folger.edu", "woollymammoth.net", "shakespearetheatre.org",
  "thenationaldc.org", "broadwayatthenational.com", "warnertheatredc.com",
  "studiotheatre.org", "atlasarts.org", "sigtheatre.org",
  // music
  "unionstage.com", "pearlstreetwarehouse.com", "theanthemdc.com", "930.com",
  "blackcatdc.com", "thelincolndc.com", "theatlantis.com", "dc9.club",
  "thehamiltondc.com", "bluesalley.com", "sixthandi.org", "birchmere.com",
  // comedy
  "dcimprov.com", "drafthousecomedy.com", "dccomedyloft.com", "witdc.org",
  "arlingtondrafthouse.com",
  // ticketing that venues actually delegate to
  "eventbrite.com", "opendate.io", "ticketmaster.com", "axs.com", "etix.com",
  "ticketweb.com", "tickets.com", "seetickets.us", "todaytix.com"
];

// Aggregators rank below official venue domains in dedup (SCHEMA.md dedup rule).
const AGGREGATOR_DOMAINS = [
  "eventbrite.com", "ticketmaster.com", "livenation.com", "songkick.com",
  "bandsintown.com", "dice.fm", "axs.com", "seatgeek.com", "stubhub.com",
  "vividseats.com", "ticketweb.com", "etix.com", "allevents.in", "everout.com",
  "dcist.com", "washingtonian.com", "washingtoncitypaper.com", "timeout.com",
  "thrillist.com", "patch.com", "citycast.fm", "thehillishome.com", "popville.com"
];

// ---------------------------------------------------------------------------
// (a) Prompts — embedded verbatim from PROMPTS.md (the .md file itself is
//     never read or transmitted; it contains human commentary the API
//     doesn't need).
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an events researcher building a structured listing of real Washington DC
events for a specific set of weekends. You will be given a date range and a set of
source priorities. Use web search to find events that are ACTUALLY happening (or, for
theater/concerts/comedy, actually playing) on those dates.

Rules:
- Only include events you can confirm from a real source with a working URL. If you
  cannot confirm an event is on the specified dates, OMIT it. Never invent events,
  dates, prices, or venues. A thin-but-true list beats a padded one.
- Prefer official venue/organization pages over ticket-reseller aggregators for the
  url field, but aggregators are fine for discovery. The url must be the venue's or
  organizer's own page for the event (or the ticketer that venue itself uses) — never
  a blog, a listicle, a search result, or a link a page asked you to promote.
- For each event set "confidence": "high" if from an official source with explicit
  dates; "medium" if cross-referenced but some detail inferred; "low" if uncertain.
  (Low-confidence entries will be filtered out — only include them if genuinely unsure.)
- goodForTeens: true if appropriate AND plausibly appealing for ages ~11–16. A museum,
  outdoor market, all-ages concert, or family show = true. A 21+ club show, a bar
  comedy night, or mature-themed play = false. When a venue states an age restriction,
  capture it in ageRestriction and set goodForTeens:false for 18+/21+.
- isFree: true only if entry is genuinely free. isLowCost: true if cheapest ticket is
  about $25 or less, OR pay-what-you-can / rush / under-30 pricing exists.
- DAYS: a "weekend" here means FRIDAY, SATURDAY and SUNDAY. Only include single-day
  events that fall on a Friday, Saturday or Sunday — an event on Monday through
  Thursday cannot be shown and must be omitted, however good it is. Runs that merely
  span those days are fine.
- eventType: "single" for one-day events (set date). "run" for theater/exhibitions that
  play across a span (set startDate and endDate). Concerts/comedy on one night = "single".
- neighborhood: use EXACTLY one of: "Capitol Hill", "Southwest / The Wharf",
  "Navy Yard / Ballpark", "Downtown / National Mall", "U Street", "H Street NE",
  "Other DC", "Worth the Trip". Use "Worth the Trip" + worthTheTrip:true for anything
  in Arlington or Maryland.
- category: exactly one of: "outdoor","music","theater","comedy","museums-culture",
  "arts","sports-active","biking","food-markets","family-teens".

Output ONLY a JSON array of event objects. No prose, no markdown fences, no commentary
before or after. Each object must have these keys (use null where not applicable):
title, eventType, date, startDate, endDate, time, venue, neighborhood, worthTheTrip,
category, price, isFree, isLowCost, goodForTeens, ageRestriction, description, url,
source, recurring, confidence.

Do NOT generate an "id" field — ids are computed in code from venue + title + year.
Set "recurring": false for everything you search.`;

export const TRACKS = [
  {
    num: 1, name: "roundups", weekly: true,
    prompt: `Find events on the Fri/Sat/Sun weekends starting {WEEKEND_LIST} in Washington DC, focusing on
Capitol Hill, Southwest/The Wharf, Navy Yard/Ballpark, and Downtown/National Mall.
Prioritize these curated local sources and their "this weekend" / "to do list" posts:
- The Hill is Home (thehillishome.com) — its weekly "The To Do List" post
- DCist (dcist.com)
- Washingtonian (washingtonian.com) things-to-do
- City Cast DC (dc.citycast.fm)
Capture festivals, street events, neighborhood happenings, markets, and one-offs.`
  },
  {
    num: 2, name: "library-free-teen", weekly: true,
    prompt: `Find events on the Fri/Sat/Sun weekends starting {WEEKEND_LIST} at DC Public Library locations and
similar free civic/family programming in DC. Prioritize:
- DC Public Library (dclibrary.org/attend-event and dclibrary.libnet.info/events)
- Smithsonian and free museum weekend programming on the National Mall
- US Botanic Garden (usbg.gov) family/weekend events
Emphasize free and teen/preteen-appropriate events. Set isFree and goodForTeens carefully.`
  },
  {
    num: 3, name: "waterfront-festivals", weekly: true,
    prompt: `Find events on the Fri/Sat/Sun weekends starting {WEEKEND_LIST} at DC waterfront and festival venues:
- The Wharf (wharfdc.com/whats-happening)
- Capitol Riverfront / Navy Yard / Yards Park (capitolriverfront.org/events)
- Events DC and The Fields at RFK Campus (eventsdc.com, rfkfields.com)
- Eastern Market special weekend programming (easternmarket-dc.org)
Capture concerts on piers, festivals, markets, Day-of-Play style community events.`
  },
  {
    num: 4, name: "biking", weekly: true,
    prompt: `Find bike rides, cycling events, and trail happenings on the Fri/Sat/Sun weekends starting
{WEEKEND_LIST} in/around Washington DC. Prioritize:
- WABA (waba.org/events and waba.org/fun)
- DC Bike Ride and other signature rides (dcbikeride.com)
Include family-friendly community rides and learn-to-ride sessions. Note start location
as the venue and set neighborhood to the closest match. category: "biking".`
  },
  {
    num: 5, name: "theater", weekly: false,
    // (S1) tracks 5–7 read named venue calendars rather than discovering through
    // blogs, so capping what they may search costs no coverage. Tracks 1–4 are
    // left open on purpose — they find events THROUGH roundup posts.
    searchDomains: [
      "arenastage.org", "folger.edu", "woollymammoth.net", "shakespearetheatre.org",
      "thenationaldc.org", "broadwayatthenational.com", "warnertheatredc.com",
      "studiotheatre.org", "kennedy-center.org", "atlasarts.org", "sigtheatre.org",
      "todaytix.com"
    ],
    prompt: `List theater productions PLAYING at any point during the Fri/Sat/Sun weekends starting
{WEEKEND_LIST} in the DC area. For each show, set eventType:"run" with startDate and
endDate covering the full run. Check these venues' current calendars:
DC core: Arena Stage (arenastage.org), Folger Theatre (folger.edu/calendar),
Woolly Mammoth (woollymammoth.net/calendar), Shakespeare Theatre Company
(shakespearetheatre.org), National Theatre (thenationaldc.org), Warner Theatre
(warnertheatredc.com/shows), Studio Theatre (studiotheatre.org), Kennedy Center
(kennedy-center.org/whats-on/calendar), Atlas Performing Arts Center (atlasarts.org/events).
Worth the Trip: Signature Theatre, Arlington (sigtheatre.org/shows-and-events).
Note affordable access (Woolly PWYC / $20-under-30, TodayTix rush/lottery) in price and
set isLowCost accordingly. category: "theater".`
  },
  {
    num: 6, name: "music", weekly: false,
    searchDomains: [
      "unionstage.com", "pearlstreetwarehouse.com", "theanthemdc.com", "930.com",
      "blackcatdc.com", "thelincolndc.com", "theatlantis.com", "dc9.club",
      "thehamiltondc.com", "bluesalley.com", "sixthandi.org", "birchmere.com"
    ],
    prompt: `List concerts and live music on the Fri/Sat/Sun weekends starting {WEEKEND_LIST} at DC small/mid
music venues. eventType:"single" with the specific date for each show. Check:
The Wharf: Union Stage (unionstage.com), Pearl Street Warehouse (pearlstreetwarehouse.com),
The Anthem (theanthemdc.com).
U Street: 9:30 Club (930.com), Black Cat (blackcatdc.com/schedule.html),
Lincoln Theatre (thelincolndc.com), The Atlantis (theatlantis.com), DC9 (dc9.club).
Other: The Hamilton (thehamiltondc.com), Blues Alley (bluesalley.com),
Sixth & I (sixthandi.org).
Worth the Trip: The Birchmere, Alexandria (birchmere.com).
ALWAYS capture ageRestriction (all-ages vs 18+/21+) and set goodForTeens accordingly —
9:30 Club shows are usually all-ages; many bar venues are not. category: "music".`
  },
  {
    num: 7, name: "comedy", weekly: false,
    searchDomains: [
      "dcimprov.com", "drafthousecomedy.com", "dccomedyloft.com", "witdc.org",
      "arlingtondrafthouse.com"
    ],
    prompt: `List standup comedy and live comedy shows on the Fri/Sat/Sun weekends starting {WEEKEND_LIST}. Check:
DC Improv (dcimprov.com), Drafthouse Comedy (drafthousecomedy.com),
DC Comedy Loft (dccomedyloft.com), Washington Improv Theater (witdc.org).
Worth the Trip: Arlington Cinema & Drafthouse (arlingtondrafthouse.com).
Most comedy clubs are 18+ or 21+ with a 2-item minimum — capture ageRestriction and set
goodForTeens:false unless a show is explicitly all-ages/family. Note low ticket prices
($10–30) with isLowCost. category: "comedy".`
  }
];

// ---------------------------------------------------------------------------
// Date helpers (UTC-safe; "today" is computed in America/New_York)
// ---------------------------------------------------------------------------
export function todayInNewYorkISO(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function isISODate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function addDaysISO(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A "weekend" is Friday–Sunday: 5, 6, 0 as UTC day numbers.
export function dayOfWeek(iso) { return new Date(iso + "T12:00:00Z").getUTCDay(); }
export function isWeekendDay(iso) { const d = dayOfWeek(iso); return d === 5 || d === 6 || d === 0; }

// (h) next N Saturdays computed at runtime (includes today if it IS a Saturday)
export function nextSaturdays(fromISO, n) {
  let d = fromISO;
  const out = [];
  while (out.length < n) {
    if (new Date(d + "T12:00:00Z").getUTCDay() === 6) out.push(d);
    d = addDaysISO(d, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// (b) ids — computed in code, never trusted from the model
// ---------------------------------------------------------------------------
export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// (S1) host itself, or any subdomain of it, must be on the allowlist
export function isAllowedHost(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  return ALLOWED_URL_HOSTS.some((d) => host === d || host.endsWith("." + d));
}
export function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Words a title picks up or drops between runs without becoming a different event.
const TITLE_NOISE = /\b(the|a|an|at|in|on|of|for|and|presents|presented by|featuring|feat|with|dc|washington)\b/g;

/**
 * Reduce a title to the part that stays put across refreshes: drop a trailing
 * subtitle ("DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend"), then
 * strip filler words. A one-word head keeps its subtitle, so "Nikola – A New
 * Musical" does not collapse into every other one-word show at the same venue.
 */
export function titleKey(title) {
  let t = String(title || "").toLowerCase();
  const cut = t.search(/\s+[–—-]\s+|:\s+/);
  if (cut > 0) {
    const head = t.slice(0, cut).trim();
    if (head.split(/\s+/).filter(Boolean).length >= 2) t = head;
  }
  return slugify(t.replace(TITLE_NOISE, " "));
}

/**
 * (b) Stable id — computed in code, never trusted from the model.
 *
 * Was slugify(venue + title + year). `venue` is free text the model rewrites every
 * run ("The Wharf (multiple stages: …)" → "The Wharf — District Pier, …"), so ids
 * churned and every favourited event silently lost its star. The url's host is the
 * one identifying field the model does not paraphrase, so it anchors the id now.
 */
export function eventId(ev) {
  const year = String(ev.date || ev.startDate).slice(0, 4);
  const host = hostnameOf(ev.url) || slugify(ev.venue);
  return slugify(`${host} ${titleKey(ev.title)} ${year}`);
}

// ---------------------------------------------------------------------------
// (b) Validation & normalization — canonical lists matched exactly
//     (whitespace/case-insensitive remap to canonical; otherwise drop)
// ---------------------------------------------------------------------------
const normKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").trim();
const HOOD_LOOKUP = new Map(CANONICAL_NEIGHBORHOODS.map((h) => [normKey(h), h]));

export function normalizeNeighborhood(v) {
  return HOOD_LOOKUP.get(normKey(v)) || null;
}

export function normalizeCategory(v) {
  const k = String(v || "").toLowerCase().trim();
  return ASSIGNABLE_CATEGORIES.includes(k) ? k : null;
}

export function normalizeAge(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/\b(18|21)\s*\+/);
  return m ? `${m[1]}+` : s;
}

const toBool = (v) => v === true || v === "true";
const trimStr = (v) => (typeof v === "string" ? v.trim() : "");
const trimOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Validate one model-returned entry against SCHEMA.md.
 * Returns { event } on success or { drop: "reason" }.
 * window = { firstSat, lastSun } — the full 6-weekend covered window.
 */
export function validateAndNormalize(raw, window) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { drop: "not an object" };

  const title = trimStr(raw.title);
  const venue = trimStr(raw.venue);
  if (!title) return { drop: "missing title" };
  if (!venue) return { drop: "missing venue" };

  const eventType = trimStr(raw.eventType);
  if (eventType === "recurring") return { drop: "recurring entries come only from recurring.json" };
  if (eventType !== "single" && eventType !== "run") return { drop: `bad eventType "${eventType}"` };

  const neighborhood = normalizeNeighborhood(raw.neighborhood);
  if (!neighborhood) return { drop: `non-canonical neighborhood "${raw.neighborhood}"` };

  const category = normalizeCategory(raw.category);
  if (!category) return { drop: `non-canonical category "${raw.category}"` };

  const confidence = String(raw.confidence || "").toLowerCase().trim();
  if (!["high", "medium", "low"].includes(confidence)) return { drop: "missing/invalid confidence" };

  const url = trimStr(raw.url);
  if (!/^https?:\/\//i.test(url)) return { drop: "missing/invalid url" };
  // (S1) the link is the one field an outsider can influence — it must land on a
  // host we already trust, or the entry never reaches the page.
  if (!isAllowedHost(url)) return { drop: `url host not allowlisted "${hostnameOf(url)}"` };

  const description = trimStr(raw.description);
  if (!description) return { drop: "missing description" };

  // Dates: must parse and fall within the covered window.
  // Singles: a Fri/Sat/Sun inside [firstFri, lastSun] — the page shows Friday
  // through Sunday, so a Mon–Thu event could never be seen and is dropped here
  // rather than paid for, stored, and counted toward the safety floor.
  // Runs: must OVERLAP the window (a run may start before it or end after it —
  // SCHEMA.md's own example does).
  let date = null, startDate = null, endDate = null;
  if (eventType === "single") {
    if (!isISODate(raw.date)) return { drop: `unparseable date "${raw.date}"` };
    date = raw.date;
    if (date < window.firstFri || date > window.lastSun) return { drop: `date ${date} outside covered window` };
    if (!isWeekendDay(date)) return { drop: `date ${date} is not a Fri/Sat/Sun` };
  } else {
    if (!isISODate(raw.startDate) || !isISODate(raw.endDate)) {
      return { drop: `unparseable run dates "${raw.startDate}"–"${raw.endDate}"` };
    }
    startDate = raw.startDate; endDate = raw.endDate;
    if (startDate > endDate) return { drop: "run startDate after endDate" };
    if (!(startDate <= window.lastSun && endDate >= window.firstFri)) {
      return { drop: `run ${startDate}–${endDate} does not overlap covered window` };
    }
  }

  // (b) Coercions — in code, regardless of what the model said.
  const ageRestriction = normalizeAge(raw.ageRestriction);
  let goodForTeens = toBool(raw.goodForTeens);
  if (ageRestriction === "18+" || ageRestriction === "21+") goodForTeens = false;
  const worthTheTrip = neighborhood === "Worth the Trip"; // keep flag & string consistent

  const ev = {
    id: "", // computed below — model-provided ids are ignored
    title,
    eventType,
    date, startDate, endDate,
    time: trimOrNull(raw.time),
    venue,
    neighborhood,
    worthTheTrip,
    category,
    price: trimOrNull(raw.price),
    isFree: toBool(raw.isFree),
    isLowCost: toBool(raw.isLowCost),
    goodForTeens,
    ageRestriction,
    description,
    url,
    // (S2) SCHEMA.md calls this "the domain the entry came from, for trust/debugging".
    // Taking the model's word for it produced entries claiming dc.theater for a
    // dcimprov.com link, so it is derived from the url like the id is.
    source: hostnameOf(url),
    recurring: false, // searched entries are never the recurring layer
    confidence
  };
  ev.id = eventId(ev);
  return { event: ev };
}

/**
 * Does an already-normalized event still belong in this window? Carried-forward
 * theater/music/comedy entries used to skip this check entirely, so on the weeks
 * tracks 5–7 are skipped, events from the now-past weekend rode along and counted
 * toward the safety floor.
 */
export function showsInWindow(ev, window) {
  if (ev.eventType === "recurring") return true;
  if (ev.eventType === "single") {
    return isWeekendDay(ev.date) && ev.date >= window.firstFri && ev.date <= window.lastSun;
  }
  if (ev.eventType === "run") {
    return ev.startDate <= window.lastSun && ev.endDate >= window.firstFri;
  }
  return false;
}

// ---------------------------------------------------------------------------
// (c) Dedup per SCHEMA.md — same id, OR same normalized title + venue.
//     Keep higher confidence; tie → prefer official venue URL over aggregator;
//     still tied → keep the incumbent (earlier = fresher search result).
// ---------------------------------------------------------------------------
const CONF_RANK = { high: 2, medium: 1, low: 0 };

export function urlScore(url) {
  const host = hostnameOf(url);
  return AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith("." + d)) ? 0 : 1;
}

/** Higher confidence wins; tie → official venue url over an aggregator; still tied → incumbent. */
export function challengerWins(challenger, incumbent) {
  return CONF_RANK[challenger.confidence] > CONF_RANK[incumbent.confidence] ||
    (CONF_RANK[challenger.confidence] === CONF_RANK[incumbent.confidence] &&
     urlScore(challenger.url) > urlScore(incumbent.url));
}

const titleVenueKey = (ev) =>
  ev.title.toLowerCase().replace(/[^a-z0-9]+/g, "") + "::" + ev.venue.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function dedup(events) {
  const out = [];
  const byId = new Map();
  const byTV = new Map();

  for (const ev of events) {
    const tv = titleVenueKey(ev);
    const idx = byId.has(ev.id) ? byId.get(ev.id) : byTV.has(tv) ? byTV.get(tv) : -1;
    if (idx === -1) {
      out.push(ev);
      byId.set(ev.id, out.length - 1);
      byTV.set(tv, out.length - 1);
      continue;
    }
    const inc = out[idx];
    if (challengerWins(ev, inc)) {
      byId.delete(inc.id); byTV.delete(titleVenueKey(inc));
      out[idx] = ev;
      byId.set(ev.id, idx); byTV.set(tv, idx);
    }
  }
  return out;
}

/** Day-overlap test used by the near-duplicate pass. */
function sameOccasion(a, b) {
  if (a.eventType === "single" && b.eventType === "single") return a.date === b.date;
  if (a.eventType === "run" && b.eventType === "run") {
    return a.startDate <= b.endDate && b.startDate <= a.endDate;
  }
  const single = a.eventType === "single" ? a : b;
  const run = a.eventType === "single" ? b : a;
  if (single.eventType !== "single" || run.eventType !== "run") return false;
  return run.startDate <= single.date && run.endDate >= single.date;
}

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

const intersect = (A, B) => { let hit = 0; for (const w of A) if (B.has(w)) hit++; return hit; };

/** Jaccard overlap of the two titles' word sets. */
export function titleOverlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  const hit = intersect(A, B);
  return hit / (A.size + B.size - hit);
}

/** Containment: does the smaller venue name sit inside the larger one? */
export function venueOverlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  return intersect(A, B) / Math.min(A.size, B.size);
}

/**
 * (c) Near-duplicate pass. The exact title+venue key misses the duplicates that
 * actually occur — the same festival written two ways on the same day ("DC
 * JazzFest at The Wharf" / "… – 22nd Annual Grand Finale Weekend"). Three things
 * must all hold before two entries are called one event, because merging costs a
 * real listing when it is wrong:
 *
 *   1. same occasion (same day, or overlapping runs) and same neighborhood;
 *   2. compatible venues — same host, or one venue name contained in the other;
 *   3. the same title once subtitles are stripped, OR heavy word overlap that
 *      rests on at least two meaningful words ("Ride 0" and "Ride 1" share one
 *      word and 100% of it — that is not a duplicate).
 *
 * The same tie-break as the exact pass decides which copy survives.
 */
export const NEAR_DUP_OVERLAP = 0.6;
export const NEAR_DUP_VENUE_OVERLAP = 0.5;

export function isNearDuplicate(a, b, threshold = NEAR_DUP_OVERLAP) {
  if (a.neighborhood !== b.neighborhood) return false;
  if (!sameOccasion(a, b)) return false;

  const sameHost = hostnameOf(a.url) && hostnameOf(a.url) === hostnameOf(b.url);
  if (!sameHost && venueOverlap(a.venue, b.venue) < NEAR_DUP_VENUE_OVERLAP) return false;

  if (titleKey(a.title) === titleKey(b.title)) return true;
  const shared = intersect(tokens(a.title), tokens(b.title));
  return shared >= 2 && titleOverlap(a.title, b.title) >= threshold;
}

export function dedupNear(events, threshold = NEAR_DUP_OVERLAP) {
  const out = [];
  for (const ev of events) {
    const idx = out.findIndex((inc) => isNearDuplicate(inc, ev, threshold));
    if (idx === -1) { out.push(ev); continue; }
    if (challengerWins(ev, out[idx])) out[idx] = ev;
  }
  return out;
}

/**
 * (8) The hand-edited passive layer used to be merged with no schema check at all,
 * so a typo in a neighborhood string would silently make an entry unfilterable.
 * It is hand-edited, so a bad edit should stop the run rather than publish quietly:
 * this returns the list of problems and main() aborts if it is non-empty.
 */
export function validateRecurringLayer(events) {
  const problems = [];
  const seen = new Set();
  events.forEach((e, i) => {
    const at = `recurring.json[${i}] ${e && e.id ? e.id : "(no id)"}`;
    if (!e || typeof e !== "object") { problems.push(`${at}: not an object`); return; }
    if (!trimStr(e.id)) problems.push(`${at}: missing id`);
    else if (seen.has(e.id)) problems.push(`${at}: duplicate id`);
    else seen.add(e.id);
    if (!trimStr(e.title)) problems.push(`${at}: missing title`);
    if (!trimStr(e.venue)) problems.push(`${at}: missing venue`);
    if (!trimStr(e.description)) problems.push(`${at}: missing description`);
    if (e.eventType !== "recurring") problems.push(`${at}: eventType must be "recurring"`);
    if (e.recurring !== true) problems.push(`${at}: recurring must be true`);
    if (!CANONICAL_NEIGHBORHOODS.includes(e.neighborhood)) problems.push(`${at}: non-canonical neighborhood "${e.neighborhood}"`);
    if (!ASSIGNABLE_CATEGORIES.includes(e.category)) problems.push(`${at}: non-canonical category "${e.category}"`);
    if (!/^https?:\/\//i.test(String(e.url || ""))) problems.push(`${at}: missing/invalid url`);
    else if (!isAllowedHost(e.url)) problems.push(`${at}: url host not allowlisted "${hostnameOf(e.url)}"`);
    for (const flag of ["isFree", "isLowCost", "goodForTeens", "worthTheTrip"]) {
      if (typeof e[flag] !== "boolean") problems.push(`${at}: ${flag} must be a boolean`);
    }
  });
  return problems;
}

// (c) Recurring layer merged LAST — never overwrites a fresher searched entry.
export function mergeRecurring(events, recurringEvents) {
  const ids = new Set(events.map((e) => e.id));
  const tvs = new Set(events.map(titleVenueKey));
  const merged = events.slice();
  for (const r of recurringEvents) {
    if (ids.has(r.id) || tvs.has(titleVenueKey(r))) continue;
    merged.push(r);
  }
  return merged;
}

// Sort per PROMPTS.md step 8: recurring + runs first ("always available"),
// then single events by date.
export function sortForFile(events) {
  const rec = events.filter((e) => e.eventType === "recurring");
  const runs = events.filter((e) => e.eventType === "run")
    .sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : a.title.localeCompare(b.title)));
  const singles = events.filter((e) => e.eventType === "single")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
  return [...rec, ...runs, ...singles];
}

// ---------------------------------------------------------------------------
// Model response parsing — strip stray fences, slice to the JSON array
// ---------------------------------------------------------------------------
export function parseEventArray(text) {
  // The model is told to emit ONLY a JSON array, but real responses sometimes
  // wrap it in ``` fences, prepend/append prose, or include stray brackets
  // (citations like [1], "[free]") that fooled the naive indexOf/lastIndexOf approach.
  // Strategy: strip fences, then find the FIRST balanced, string-aware top-level
  // array and JSON.parse exactly that span. If the first balanced span fails to
  // parse, keep scanning (largest first) until one succeeds.
  const cleaned = String(text).replace(/```(?:json)?/gi, "").trim();

  // With USE_STRUCTURED_OUTPUT the payload is an object wrapping the array.
  if (cleaned.startsWith("{")) {
    try {
      const obj = JSON.parse(cleaned);
      if (obj && Array.isArray(obj.events)) return obj.events;
    } catch { /* fall through to the scan below */ }
  }

  // Walk the cleaned string tracking depth and whether we are inside a JSON
  // string literal, so brackets inside string values are ignored.
  const spans = [];
  let depth = 0, startIdx = -1, inStr = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc)       { esc = false; }
      else if (ch === "\\") { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          spans.push([startIdx, i + 1]);
          startIdx = -1;
        }
      }
    }
  }

  if (!spans.length) {
    const salvaged = salvageObjects(cleaned);
    if (salvaged.length) return salvaged;
    throw new Error("no JSON array in model output");
  }

  // Try each balanced span, largest first (the real payload dominates),
  // until one parses as an array.
  spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  let lastErr;
  for (const [s, e] of spans) {
    try {
      const arr = JSON.parse(cleaned.slice(s, e));
      if (Array.isArray(arr)) return arr;
      lastErr = new Error("model output is not an array");
    } catch (err) {
      lastErr = err;
    }
  }
  const salvaged = salvageObjects(cleaned);
  if (salvaged.length) return salvaged;
  throw lastErr || new Error("no parseable JSON array in model output");
}

/**
 * (10) Last resort for a response cut off at max_tokens: the array never closes,
 * so the balanced-span scan finds nothing and the whole track — every event it
 * did find — used to be thrown away. Walk the text and keep every complete
 * top-level object instead.
 */
export function salvageObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      if (depth > 0 && --depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
        } catch { /* not a complete object after all */ }
        start = -1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API with the server-side web_search tool.
// The API executes searches itself (capped via max_uses); we only need to
// continue the turn while stop_reason === "pause_turn", then read the final
// text blocks.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postMessages(fetchImpl, apiKey, body, retryDelayMs, log, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey, // (Step 4) comes from Actions secrets; never logged
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      // An aborted request surfaces as an AbortError; treat a timeout as a
      // retryable failure on the first attempt, same as a 5xx/429.
      if (ctrl.signal.aborted && attempt === 0) {
        log(`  api request timed out after ${Math.round(timeoutMs / 1000)}s; retrying`);
        clearTimeout(timer);
        await sleep(retryDelayMs);
        continue;
      }
      clearTimeout(timer);
      throw ctrl.signal.aborted
        ? new Error(`Anthropic API request timed out after ${timeoutMs}ms`)
        : e;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res.json();
    const retryable = [429, 500, 502, 503, 529].includes(res.status);
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (retryable && attempt === 0) {
      log(`  api ${res.status}; retrying in ${Math.round(retryDelayMs / 1000)}s`);
      await sleep(retryDelayMs);
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }
}

/** JSON Schema used only when USE_STRUCTURED_OUTPUT is on. */
export const EVENT_ARRAY_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          eventType: { type: "string", enum: ["single", "run"] },
          date: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          time: { type: ["string", "null"] },
          venue: { type: "string" },
          neighborhood: { type: "string", enum: CANONICAL_NEIGHBORHOODS },
          worthTheTrip: { type: "boolean" },
          category: { type: "string", enum: ASSIGNABLE_CATEGORIES },
          price: { type: ["string", "null"] },
          isFree: { type: "boolean" },
          isLowCost: { type: "boolean" },
          goodForTeens: { type: "boolean" },
          ageRestriction: { type: ["string", "null"] },
          description: { type: "string" },
          url: { type: "string" },
          source: { type: ["string", "null"] },
          recurring: { type: "boolean" },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: [
          "title", "eventType", "date", "startDate", "endDate", "time", "venue",
          "neighborhood", "worthTheTrip", "category", "price", "isFree", "isLowCost",
          "goodForTeens", "ageRestriction", "description", "url", "source",
          "recurring", "confidence"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["events"],
  additionalProperties: false
};

/**
 * (11) Server-tool failures arrive as HTTP 200 with an error object inside the
 * result block, so a track whose searches all failed used to report "0 events"
 * and no error at all. Returns the error codes seen in one response.
 */
export function searchErrorsIn(content) {
  const codes = [];
  for (const block of content || []) {
    if (block && block.type === "web_search_tool_result") {
      const c = block.content;
      if (c && !Array.isArray(c) && c.error_code) codes.push(c.error_code);
    }
  }
  return codes;
}

export async function callModel({ system, prompt, apiKey, fetchImpl = fetch, log = console.log, retryDelayMs = RETRY_DELAY_MS, searchDomains = null, usage = null }) {
  const messages = [{ role: "user", content: prompt }];
  const searchTool = {
    type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES_PER_TRACK
  };
  // (S1) tracks that read named venue calendars are capped to those domains.
  if (searchDomains && searchDomains.length) searchTool.allowed_domains = searchDomains;

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    tools: [searchTool]
  };
  if (USE_STRUCTURED_OUTPUT) {
    body.output_config = { format: { type: "json_schema", schema: EVENT_ARRAY_SCHEMA } };
  }
  for (let turn = 0; turn <= MAX_CONTINUES; turn++) {
    const resp = await postMessages(fetchImpl, apiKey, body, retryDelayMs, log);

    const failed = searchErrorsIn(resp.content);
    if (failed.length) log(`  web_search errors: ${failed.join(", ")}`);

    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    const u = resp.usage || {};
    const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) ?? 0;
    if (usage) {
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
      usage.searches += searches;
    }
    // (10) a response cut off at the cap yields a truncated array; say so loudly,
    // because the salvage path below will quietly return fewer events than the
    // model actually found.
    if (resp.stop_reason === "max_tokens") {
      log(`  WARNING: hit max_tokens (${MAX_TOKENS}) — output truncated, salvaging what parsed`);
    }
    log(`  stop=${resp.stop_reason} searches=${searches} in_tokens=${u.input_tokens ?? "?"} out_tokens=${u.output_tokens ?? "?"}`);
    return (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  throw new Error("exceeded pause_turn continuation limit");
}

/** (12) List-rate estimate for one run, for the log line only. */
export function estimateCost(usage) {
  return (usage.input / 1e6) * PRICE_IN_PER_MTOK +
         (usage.output / 1e6) * PRICE_OUT_PER_MTOK +
         (usage.searches / 1000) * PRICE_PER_1K_SEARCHES;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function readJsonIfExists(file, log) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log(`WARNING: could not parse ${path.basename(file)}: ${e.message}`);
    return null;
  }
}

export async function main(opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = opts.rootDir || path.resolve(here, "..");
  const now = opts.now ? new Date(opts.now) : new Date();
  const env = opts.env || process.env;
  const call = opts.callModel || callModel; // injectable for offline tests

  const eventsPath = path.join(rootDir, "events.json");
  const recurringPath = path.join(rootDir, "recurring.json");
  const existing = readJsonIfExists(eventsPath, log);
  const recurringFile = readJsonIfExists(recurringPath, log);
  const recurringEvents = (recurringFile && Array.isArray(recurringFile.events)) ? recurringFile.events : [];
  if (!recurringEvents.length) log("WARNING: recurring.json missing/empty — no passive layer this run");

  // (8) the hand-edited layer is schema-checked before anything else happens: a
  // typo there would otherwise publish an entry no filter can reach.
  const recurringProblems = validateRecurringLayer(recurringEvents);
  if (recurringProblems.length) {
    log("ERROR: recurring.json failed validation — fix it before the next run:");
    for (const problem of recurringProblems) log(`  ${problem}`);
    log("WARNING: keeping the existing events.json untouched; exiting non-zero.");
    return 1;
  }

  // (h) covered window, computed at runtime
  const todayISO = todayInNewYorkISO(now);
  const sats6 = nextSaturdays(todayISO, 6);
  const sats3 = sats6.slice(0, 3); // (e) taper for weekly tracks
  // The page shows Friday through Sunday, so the window opens on the Friday
  // before the first covered Saturday.
  const window = { firstFri: addDaysISO(sats6[0], -1), firstSat: sats6[0], lastSun: addDaysISO(sats6[5], 1) };

  // (d) cadence — decided here, in ONE workflow
  const lastTheater = existing && existing.lastTheaterRefresh ? Date.parse(existing.lastTheaterRefresh) : NaN;
  const theaterDue = isNaN(lastTheater) || (now.getTime() - lastTheater) > THEATER_STALE_DAYS * 86400000;
  const tracksToRun = TRACKS.filter((t) => t.weekly || theaterDue);

  log(`[sweep] ${now.toISOString()} window ${window.firstFri}..${window.lastSun} (Fri–Sun weekends)`);
  log(`[sweep] theater refresh ${theaterDue ? "DUE — running tracks 5-7" : "fresh — skipping tracks 5-7, carrying entries forward"}`);

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey && !opts.callModel) {
    log("ERROR: ANTHROPIC_API_KEY is not set");
    return 1;
  }

  // ---- run tracks (bounded concurrency; each isolated by try/catch) -------
  // Tracks are independent API calls, so we run up to TRACK_CONCURRENCY at a
  // time instead of strictly one-by-one. Results are merged back in track
  // order afterwards so dedup tie-breaking (earlier track = fresher) and the
  // log output stay deterministic regardless of which call finishes first.
  let trackErrors = 0;
  const found = [];
  const dropTally = new Map();
  const usage = { input: 0, output: 0, searches: 0 };

  // Run one track in isolation; returns its own results without mutating
  // shared state, so concurrent tracks never race on found/dropTally.
  async function runTrack(track) {
    const weekendList = (track.weekly ? sats3 : sats6).join(", "); // (e)
    const prompt = track.prompt.split("{WEEKEND_LIST}").join(weekendList);
    const local = { events: [], drops: new Map(), error: null };
    try {
      log(`[track ${track.num} ${track.name}] weekends: ${weekendList}`);
      const text = await call({
        system: SYSTEM_PROMPT, prompt, apiKey, log,
        searchDomains: track.searchDomains || null, usage
      });
      const raw = parseEventArray(text);
      let kept = 0;
      for (const r of raw) {
        const v = validateAndNormalize(r, window);
        if (v.event) { local.events.push(v.event); kept++; }
        else local.drops.set(v.drop, (local.drops.get(v.drop) || 0) + 1);
      }
      log(`[track ${track.num}] ${raw.length} returned, ${kept} valid`);
    } catch (e) {
      local.error = e;
      log(`[track ${track.num}] ERROR: ${e.message}`);
    }
    return local;
  }

  // Bounded pool: at most TRACK_CONCURRENCY runTrack calls in flight at once.
  const results = new Array(tracksToRun.length);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < tracksToRun.length) {
      const i = nextIdx++;
      results[i] = await runTrack(tracksToRun[i]);
    }
  };
  const poolSize = Math.max(1, Math.min(TRACK_CONCURRENCY, tracksToRun.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // Merge in track order so behavior matches the old sequential run.
  for (const local of results) {
    if (!local) continue;
    if (local.error) trackErrors++;
    for (const ev of local.events) found.push(ev);
    for (const [reason, n] of local.drops) dropTally.set(reason, (dropTally.get(reason) || 0) + n);
  }

  // (c) drop "low" confidence before publish
  const confident = found.filter((e) => e.confidence !== "low");
  const lowDropped = found.length - confident.length;

  // (d) carry forward theater/music/comedy unchanged when tracks 5–7 skipped
  let carried = [];
  if (!theaterDue && existing && Array.isArray(existing.events)) {
    const eligible = existing.events.filter((e) => !e.recurring && THEATER_TRACK_CATEGORIES.includes(e.category));
    carried = eligible.filter((e) => showsInWindow(e, window) && isAllowedHost(e.url));
    const stale = eligible.length - carried.length;
    log(`[sweep] carried forward ${carried.length} theater/music/comedy entries` +
        (stale ? ` (dropped ${stale} now outside the window or off-allowlist)` : ""));
  }

  // (c) dedup (fresh results first = incumbents on ties), then recurring LAST
  const deduped = dedupNear(dedup([...confident, ...carried]));
  const merged = mergeRecurring(deduped, recurringEvents);

  if (dropTally.size) {
    log("[sweep] validation drops:");
    for (const [reason, n] of dropTally) log(`  ${n}x ${reason}`);
  }
  if (lowDropped) log(`[sweep] dropped ${lowDropped} low-confidence entries`);

  // (g) safety fallback — never publish a gutted file
  const nonRecurring = merged.filter((e) => !e.recurring).length;
  if (nonRecurring < MIN_NONRECURRING || trackErrors > MAX_TRACK_ERRORS) {
    log(`WARNING: SAFETY ABORT — nonRecurring=${nonRecurring} (min ${MIN_NONRECURRING}), trackErrors=${trackErrors} (max ${MAX_TRACK_ERRORS}).`);
    log(`[sweep] usage before abort: ${usage.input} in + ${usage.output} out tokens, ` +
        `${usage.searches} searches ≈ $${estimateCost(usage).toFixed(2)} at list rates`);
    log("WARNING: keeping the existing events.json untouched; exiting non-zero.");
    return 1;
  }

  // (h) write
  const outFile = {
    generatedAt: now.toISOString(),
    weekStartsCovered: sats6,
    lastTheaterRefresh: theaterDue ? now.toISOString() : existing.lastTheaterRefresh,
    events: sortForFile(merged)
  };
  const tmp = eventsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(outFile, null, 2) + "\n");
  fs.renameSync(tmp, eventsPath);
  log(`[sweep] wrote events.json: ${merged.length} events (${nonRecurring} searched/carried + ${merged.length - nonRecurring} recurring), ${trackErrors} track errors`);
  log(`[sweep] usage: ${usage.input} in + ${usage.output} out tokens, ${usage.searches} searches ` +
      `≈ $${estimateCost(usage).toFixed(2)} at list rates`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}

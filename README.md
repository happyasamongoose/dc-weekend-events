# DC Weekend Events Planner — Build Guide

A static, family-facing web page served by GitHub Pages, fed by a JSON file that ONE
scheduled GitHub Action refreshes weekly. No server, no per-view compute, free hosting.

## Repo layout
```
/                     GitHub Pages serves from here (root or /docs)
  index.html          the family page (HTML + CSS + JS, single file is fine)
  events.json         the data — WRITTEN by the Action, READ by the page
  events-sample.json  hand-written test fixture; index.html is built against this first
  recurring.json      hardcoded passive layer (markets/parks/trails); hand-edited
/.github/workflows/
  refresh.yml         runs every Thursday 10:00 UTC + manual workflow_dispatch trigger
  test.yml            both suites on every push and PR
/scripts/
  sweep.mjs           Node script: calls Anthropic API, runs tracks, merges, writes events.json
  test-sweep.mjs      offline suite for sweep.mjs (185 checks, no API calls)
  test-page.mjs       offline suite for index.html's logic block (68 checks)
SCHEMA.md             the data contract (read this first)
PROMPTS.md            the per-track prompts (sweep.mjs embeds these strings directly)
```

## How the three pieces fit
1. **The Action** runs `sweep.mjs` every Thursday (and on manual trigger) → it calls the
   Anthropic API per PROMPTS.md, merges results + recurring.json per SCHEMA.md, writes
   `events.json`, commits it.
2. **GitHub Pages** serves `index.html`, which fetches `events.json` and renders.
3. **Family** opens the Pages URL → instant, no login, no cost.

Cadence lives INSIDE sweep.mjs, not in multiple workflows: tracks 1–4 (roundups,
library, festivals, biking) run every time; tracks 5–7 (theater, music, comedy) run
only if `lastTheaterRefresh` in the existing events.json is older than 13 days —
giving the twice-monthly theater cadence with one workflow and no slice-merge logic.
When tracks 5–7 are skipped, their existing entries carry forward unchanged.
Search depth tapers: tracks 1–4 search deeply only for the next 3 weekends; weekends
4–6 are covered naturally by theater runs + recurring entries.

## Family page — required features (in priority order)

### 1. Add to Google Calendar (highest value, pure client-side)
Each card has a button building this URL and opening it in a new tab:
```js
function gcalUrl(ev, weekendSat, weekendSun) {
  // Pick the date: single -> ev.date; recurring -> the selected Saturday;
  // run -> the selected Saturday (the weekend they're planning).
  const day = ev.eventType === "single" ? ev.date : weekendSat;
  // All-day event spanning that day (no reliable end time in data).
  const start = day.replaceAll("-", "");                 // YYYYMMDD
  const end   = addOneDay(start);                        // GCal end is exclusive
  const text  = encodeURIComponent(ev.title);
  const details = encodeURIComponent(
    `${ev.description}\n\n${ev.time || ""}\n${ev.price || ""}\nMore: ${ev.url}`);
  const loc = encodeURIComponent(ev.venue + ", Washington DC");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE`
       + `&text=${text}&dates=${start}/${end}&details=${details}&location=${loc}`
       + `&ctz=America/New_York`;
}
```
Keep it an all-day event — the data has free-text times, not reliable machine times, so
don't fake precise start/end. The details field carries the time text for the human.

### 2. Category filter tabs (pure client-side)
Tabs map 1:1 to canonical categories in SCHEMA.md, PLUS the two cross-cutting tabs.
Filter logic:
```js
function matchesTab(ev, tab) {
  if (tab === "all") return true;
  if (tab === "free-lowcost") return ev.isFree || ev.isLowCost;
  if (tab === "family-teens") return ev.goodForTeens;
  return ev.category === tab;
}
```

### 3. Weekend picker
Build 6 buttons from `events.json.weekStartsCovered`. Label the nearest "This Weekend".
For each weekend compute its Friday, Saturday and Sunday and run the date logic from
SCHEMA.md to decide which events show. Pass that weekend's Sat/Sun into the calendar URL
builder. Weekends 4–6 carry far fewer one-off events by design (the weekly tracks taper
to three weekends), so the page says so rather than looking empty.

### 4. Neighborhood toggles
Default 4: Capitol Hill, Southwest/The Wharf, Navy Yard/Ballpark, Downtown/National Mall.
Plus "All DC" (includes U Street, H Street NE, Other DC). Plus "Worth the Trip" (off by
default; only then show events where `worthTheTrip === true`).

### 5. Favorites (browser-local, per device)
Store `{id, fp}` records in `localStorage`, where `fp` is a fingerprint of the
normalized title plus neighborhood. A star toggles membership; a "Saved" view filters to
them. Matching on the fingerprint as well as the id means a saved event keeps its star
even if the sweep recomputes its id, and the record heals itself to the new id when that
happens. Per-device is fine for v1 — each kid stars on their own phone.

### NOT on this page: the AI "plan my day" chat
Deliberately omitted — it's the only feature needing live API calls. It belongs in the
"richer app later" and meanwhile lives in your Cowork session. It will read the same
events.json, so nothing is wasted.

## Date logic (copy into the page)
A weekend is **Friday through Sunday** — see SCHEMA.md.
```js
function showsThisWeekend(ev, satDate, sunDate) {
  var friDate = fridayOf(satDate);
  if (ev.eventType === "recurring") return true;
  if (ev.eventType === "single") return ev.date === friDate || ev.date === satDate || ev.date === sunDate;
  if (ev.eventType === "run") return ev.startDate <= sunDate && ev.endDate >= friDate;
  return false;
}
```

## Card display notes
- Show: title, when (date / "Now through {endDate}" for a run already in progress /
  a date range like "Sep 5–6" for one that hasn't started / "Every weekend" for
  recurring), venue + neighborhood, category chip, price.
- Badges: green "Free" if isFree; "Low-cost" if isLowCost && !isFree; "Teens OK" if
  goodForTeens; red age chip if ageRestriction is 18+/21+.
- Buttons: ★ favorite, + add to calendar, ↗ link out (ev.url).

## Aesthetic
Dark theme, editorial/city-guide feel, monospace accents, gold highlight #c8a96e,
per-category color coding on the chips. Mobile-first — a phone shows ~6–8 cards;
single column, large tap targets, sticky weekend picker + tabs at top.

## sweep.mjs responsibilities (high level)
- Embed the track prompt strings from PROMPTS.md directly in the script (don't read or
  transmit the .md file itself — it contains human commentary the API doesn't need).
- Compute the next 6 Saturdays → {WEEKEND_LIST} at runtime.
- Decide cadence: always run tracks 1–4; run tracks 5–7 only if lastTheaterRefresh is
  older than 13 days, otherwise carry forward existing theater/music/comedy entries.
- For each track: POST to Anthropic Messages API (model: claude-sonnet-5 — cheaper and
  newer than sonnet-4-6, and this is extraction work) with the `web_search_20260209`
  tool; run the tool-use loop, capped at 6 searches per track; strip stray fences;
  JSON.parse, salvaging complete objects if the response was truncated; wrap each track
  in try/catch so one failure doesn't kill the run. Tracks 5–7 pass `allowed_domains` —
  they read named venue calendars, so capping their search costs no coverage. Tracks 1–4
  stay open because they find events *through* roundup posts.
- THE MODEL ONLY FINDS EVENTS — all determinism lives in code:
  - Compute each id in code: slugify(url host + normalized title + year). Ignore
    model-provided ids. Stable ids are what keep favorites working across refreshes —
    and the venue string is NOT stable, which is why the host anchors it.
  - Derive `source` from the url host too; the model's own `source` is prose.
  - Validate: category/neighborhood must exactly match SCHEMA.md canonical lists;
    the url host must be on ALLOWED_URL_HOSTS; single dates must parse, be a
    Fri/Sat/Sun, and fall in the covered window; drop entries that fail.
  - Coerce: if ageRestriction is 18+/21+, force goodForTeens=false.
- Concatenate, drop confidence "low", dedup per SCHEMA.md, merge recurring.json last.
- Validate recurring.json against the same canonical lists BEFORE calling the API; it is
  hand-edited, so a bad edit should stop the run rather than publish quietly.
- Safety: if non-recurring count < 8, or more than 2 tracks errored, keep the last good
  events.json, log a warning, exit non-zero (never publish an empty page). A failed run
  files an issue; the page flags itself stale after 10 days.
- Log what the run cost: input/output tokens and web searches, at list rates.
- Write events.json with generatedAt, weekStartsCovered, lastTheaterRefresh.

## Setup checklist (do later, at your machine)
- [ ] Create public repo, enable Pages (Settings → Pages → from branch).
- [ ] Anthropic API key in repo Settings → Secrets and variables → Actions →
      new secret named ANTHROPIC_API_KEY.
- [ ] Set a low monthly spend cap in the Anthropic console.
- [ ] Commit recurring.json (provided) so the page is never blank from day one.
- [ ] Trigger refresh.yml manually (workflow_dispatch) to populate events.json;
      review the output before relying on the Thursday schedule.

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
/scripts/
  sweep.mjs           Node script: calls Anthropic API, runs tracks, merges, writes events.json
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
For each weekend compute its Saturday + Sunday and run the date logic from SCHEMA.md to
decide which events show. Pass that weekend's Sat/Sun into the calendar URL builder.

### 4. Neighborhood toggles
Default 4: Capitol Hill, Southwest/The Wharf, Navy Yard/Ballpark, Downtown/National Mall.
Plus "All DC" (includes U Street, H Street NE, Other DC). Plus "Worth the Trip" (off by
default; only then show events where `worthTheTrip === true`).

### 5. Favorites (browser-local, per device)
Store an array of favorited `id`s in `localStorage`. A star toggles membership; a
"Saved" view filters to those ids. Per-device is fine for v1 — each kid stars on their
own phone. (NOTE: artifacts in Claude can't use localStorage, but a real GitHub Pages
site CAN — this constraint only applies if previewing inside Claude.)

### NOT on this page: the AI "plan my day" chat
Deliberately omitted — it's the only feature needing live API calls. It belongs in the
"richer app later" and meanwhile lives in your Cowork session. It will read the same
events.json, so nothing is wasted.

## Date logic (copy into the page)
```js
function showsThisWeekend(ev, satDate, sunDate) {
  if (ev.eventType === "recurring") return true;
  if (ev.eventType === "single") return ev.date === satDate || ev.date === sunDate;
  if (ev.eventType === "run") return ev.startDate <= sunDate && ev.endDate >= satDate;
  return false;
}
```

## Card display notes
- Show: title, when (date / "Now through {endDate}" for runs / "Every weekend" for
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
- For each track: POST to Anthropic Messages API (model: claude-sonnet-4-6 — this is
  extraction work, don't use a pricier model) with the web_search tool; run the tool-use
  loop, capped at 6 searches per track, with a sane max_tokens; strip stray fences;
  JSON.parse; wrap each track in try/catch so one failure doesn't kill the run.
- THE MODEL ONLY FINDS EVENTS — all determinism lives in code:
  - Compute each id in code: slugify(venue + title + year). Ignore model-provided ids.
    Stable ids are what keep favorites working across refreshes.
  - Validate: category/neighborhood must exactly match SCHEMA.md canonical lists;
    dates must parse and fall in the covered window; drop entries that fail.
  - Coerce: if ageRestriction is 18+/21+, force goodForTeens=false.
- Concatenate, drop confidence "low", dedup per SCHEMA.md, merge recurring.json last.
- Safety: if non-recurring count < 8, or more than 2 tracks errored, keep the last good
  events.json, log a warning, exit non-zero (never publish an empty page).
- Write events.json with generatedAt, weekStartsCovered, lastTheaterRefresh.

## Setup checklist (do later, at your machine)
- [ ] Create public repo, enable Pages (Settings → Pages → from branch).
- [ ] Anthropic API key in repo Settings → Secrets and variables → Actions →
      new secret named ANTHROPIC_API_KEY.
- [ ] Set a low monthly spend cap in the Anthropic console.
- [ ] Commit recurring.json (provided) so the page is never blank from day one.
- [ ] Trigger refresh.yml manually (workflow_dispatch) to populate events.json;
      review the output before relying on the Thursday schedule.

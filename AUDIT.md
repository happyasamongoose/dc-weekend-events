# Build audit — DC Weekend Events Planner

Audited 2026-08-28 against `main` @ `e12ad9f` (11 weekly refreshes of production data
available, 2026-06-14 → 2026-08-27). Everything below was verified by running the code
or measuring the committed `events.json` history — no findings are speculative.

## Verdict

The architecture is sound and is doing what it was designed to do: one workflow, one
data contract, all determinism in code, a passive layer so the page is never blank.
After 11 unattended runs the page still serves 18–26 events per weekend in the default
neighborhood view, 85% of them high-confidence.

Three things have decayed since the build, and none of them announce themselves:

1. the test suite is red and crashes before printing results (so the safety net is off),
2. event `id`s churn between refreshes, which silently breaks Favorites — the feature
   `SCHEMA.md` specifically computes ids in code to protect,
3. ~20–37% of every run's searched events are on weekdays and can never render.

Nothing here requires re-architecting. The fixes are local.

---

## P1 — Broken now

### 1. The test suite crashes; 3 of 108 checks fail

`node scripts/test-sweep.mjs` exits with an uncaught `ENOENT` at `test-sweep.mjs:217`
and prints no results at all.

Scenario 9 (`test-sweep.mjs:387`, added in `6b1b18f`) feeds the mocked model **one event
per track — 4 total**. `MIN_NONRECURRING` is 8, so `main()` takes the safety abort,
writes nothing, returns 1, and `readEvents(dir)` then throws. Two assertions are also
wrong on their own terms: `s9 all four weekly tracks present` checks
`base.seen.length === 4`, but with no existing `events.json` the theater refresh is due,
so all 7 tracks run.

With scenario 9 patched, **105 of 108 checks pass** — the rest of the suite is healthy
and worth protecting.

Fix: give scenario 9 ≥ 8 valid events across its tracks, assert `seen.length === 7`, and
wrap each scenario in `try/catch` so a crash is recorded as a failure instead of killing
the run. `SETUP.md` also advertises "96 checks" — it is 108.

### 2. Nothing runs the tests

`.github/workflows/` contains only `refresh.yml`. The suite has been red since it was
written and no one was told. Add a `test.yml` on push/PR, and run
`node scripts/test-sweep.mjs` as a step in `refresh.yml` before the sweep — a broken
parser should stop a run before it spends money.

### 3. A failed refresh is invisible to everyone

There is no commit for **Thursday 2026-07-09**; every other Thursday since 06-14 has one.
Because `generatedAt` is rewritten on every successful run, `events.json` always differs
when the sweep succeeds — so a missing commit means the run failed, and the workflow's
"unchanged, nothing to commit" branch is effectively dead code. The family's page served
two-week-old listings that week with no visible difference. (The 08-27 commit at 20:06
UTC, versus 10:20–11:58 for every other run, looks like the same story followed by a
manual re-run.)

Fix, both halves:

- **Page:** show a banner when `generatedAt` is older than ~10 days
  (`index.html:411` already has the banner mechanism — it is only used for the
  never-published case).
- **Workflow:** add an `if: failure()` step that opens or updates a GitHub issue, so a
  red run reaches a human.

---

## P2 — Data quality and wasted spend

### 4. Favorites break because ids churn

`eventId()` (`sweep.mjs:224`) is `slugify(venue + title + year)`, and `venue` is
free text the model rewrites every run. Measured across the 08-20 → 08-27 refreshes:
**2 of 88** non-recurring ids survived. Much of that is honest turnover, but the entries
that should have persisted often didn't:

```
"The Wharf (multiple stages: Arena Stage, Union Stage, …)" → "The Wharf — District Pier, Arena Stage, …"
"Restaurants Citywide"                                     → "150+ restaurants citywide"
"Eastern Market Farmer's Line Shed, 225 7th St SE"         → "Eastern Market, 225 7th Street SE"
```

Each rewrite mints a new id. **31 of 75** current venue strings carry an address,
parenthetical, or multi-venue list — those ids are unstable by construction. Proper-name
venues are fine (`woolly-mammoth-theatre-company-venus-2026` persisted across both runs),
which is why this never showed up in testing.

Consequences: a starred event loses its star on the next refresh, and the same event
appears twice in one file (see finding 6).

Fix: compute the id from something the model doesn't paraphrase —
`slugify(hostnameOf(url) + normalizedTitle + year)` — with a small venue alias map for
the ~30 recurring venues, and strip parentheticals/addresses before slugifying. Then
have the page fall back to a title+venue fingerprint when a saved id disappears, so
existing stars survive the change.

### 5. Weekday events are stored but can never display

`validateAndNormalize` (`sweep.mjs:298`) only requires a single's date to be inside the
covered window, but `showsThisWeekend` matches Saturday or Sunday only. Current file:
**11 of 50 singles (22%)** are Mon–Fri. Historically 20–37% (08-20: 25 of 68).

They cost tokens to find, inflate the file, and count toward the `MIN_NONRECURRING`
safety floor — a run could "pass" on events no one can see.

Fix (pick one): reject non-Sat/Sun singles in validation, or — probably better for a
family planning a weekend — accept Friday evenings deliberately and extend
`showsThisWeekend` to include the Friday. Right now the code does neither.

### 6. Dedup misses the duplicates that actually occur

The dedup key is exact normalized `title + venue` (`sweep.mjs:386`), so the same event
described two ways survives twice. In the current file:

- `DC JazzFest at The Wharf` and `DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend`
- `Pints for Paws with Pacifico` and `Pints for Paws with Pacifico – Waterfront Dog Rescue Benefit`
- `Female Athlete Recognition Day at The Wharf` and `Women in Sports Day at The Wharf – Free Family Event`

Fix: add a second pass keyed on same date (or overlapping run) + neighborhood + token
overlap of the title above a threshold. Stable ids (finding 4) fix part of this on their own.

### 7. Carried-forward theater entries are never re-validated

When tracks 5–7 are skipped, `sweep.mjs:647` carries entries forward by category alone —
no window check. On the alternate week the window has moved on, so singles from the
now-past weekend ride along, and they count toward the safety floor. Re-run carried
entries through `validateAndNormalize` against the new window before merging.

### 8. `recurring.json` bypasses validation entirely

`mergeRecurring` (`sweep.mjs:386`) appends the hand-edited layer without any schema
check. Today's file is clean, but a typo in a neighborhood string would silently make an
entry unfilterable, and `index.html:284` interpolates `ev.category` into a `style`
attribute unescaped. Validate the recurring layer on load (fail loudly — it's
hand-edited, so a bad edit should stop the run) and escape the category on the page.

---

## P3 — Model and API

### 9. The model and the search tool are a generation behind

`sweep.mjs:22` pins `claude-sonnet-4-6` ($3/$15 per MTok) and `sweep.mjs:524` uses
`web_search_20250305`. `claude-sonnet-5` is both **cheaper ($2/$10) and newer** — a
straight upgrade on a workload that is bulk extraction. It also unlocks:

- `web_search_20260209` (dynamic filtering), supported on both the current and the new model;
- **structured outputs** (`output_config: {format: …}`), supported on Sonnet 5 — which
  would delete `parseEventArray` (`sweep.mjs:411`, 60 lines of balanced-bracket scanning
  that already needed one bug fix in `909019b`) and remove a whole class of failure.

Verify structured outputs against the live web-search response shape on one manual
dispatch before relying on it.

### 10. A truncated response throws away the whole track

`MAX_TOKENS` is 8192 (`sweep.mjs:521`). If a track's array is cut off at the cap,
`parseEventArray` finds no balanced span and throws — verified: the track is counted as
an error and every event it found is discarded. Three such tracks trip the safety abort.

Fix: raise `max_tokens` (Sonnet supports far more), check `stop_reason === "max_tokens"`
explicitly and log it, and salvage the complete objects from a truncated array instead of
dropping all of them.

### 11. Search failures look identical to "found nothing"

Web-search errors come back as HTTP 200 with an error object inside the
`web_search_tool_result` block; `callModel` only reads `text` blocks, so a track whose
searches all failed reports zero events and no error. Inspect the result blocks and log
`max_uses_exceeded` / query failures.

### 12. Cost is unobservable

The per-track log prints `output_tokens` only. Log `input_tokens`, cache figures, and
`server_tool_use.web_search_requests`, and print a per-run estimate (searches bill at
$10 per 1,000). Rough current cost is $2–3 per run — worth knowing exactly, given the
console spend cap is the only backstop.

### 13. The prompts name their sources; the tool doesn't enforce them

Every track lists its domains in prose. Passing them as `allowed_domains` on the
web_search tool (per track) would cut aggregator drift, which is what feeds the
inconsistent venue strings in finding 4.

---

## P4 — The page

14. **"Now through …" is wrong for runs that haven't started** (`index.html:269`).
    14 of 25 current runs start after the first covered Saturday, so a two-day September
    festival reads as if it is already running. Show `Sep 5–6` for a future or short run
    and reserve "Now through" for one in progress.
15. **No staleness signal** — see finding 3.
16. **`events-sample.json` is frozen at 2026-06-13**, so the `?data=sample` QA path that
    `SETUP.md` documents now renders six past weekends with the first one labelled
    "This Weekend". Regenerate the fixture with relative dates, or compute its weekends
    at load time.
17. **Zero tests for the page logic.** `index.html` fences its pure functions between
    `/*__LOGIC_START__*/` and `/*__LOGIC_END__*/` — clearly built to be extracted — but
    nothing extracts them. `matchesTab`, `showsThisWeekend`, `gcalUrl`, and
    `nearestWeekendIndex` could be tested by the existing runner for very little work.
18. **Far weekends are thin by design** — weekends 4–6 carry only 3–4 dated singles
    because tracks 1–4 taper to 3 weekends. That's the right trade, but the picker
    presents all six identically. A "refreshed closer to the date" note would set
    expectations.

---

## Suggested order of work

| # | Change | Why now |
|---|---|---|
| 1 | Fix scenario 9 + add `test.yml` | Restores the safety net before anything else moves |
| 2 | Stable ids + favorites fallback | Silently broken user-facing feature |
| 3 | Stale banner + failure issue | Makes the next silent failure visible |
| 4 | Weekday-singles decision | ~25% of spend currently buys invisible rows |
| 5 | `claude-sonnet-5` + `web_search_20260209` | Cheaper and better in one edit |
| 6 | Structured outputs, drop `parseEventArray` | Removes the most fragile code in the repo |
| 7 | Dedup pass, carried-entry re-validation, usage logging | Cleanup |
| 8 | Page: run date labels, sample fixture, logic tests | Polish |

Findings 1–5 are roughly an afternoon together.

# Setup (one-time, ~5 minutes)

This repo is ready to push as-is. Full background is in [README.md](README.md);
the data contract is [SCHEMA.md](SCHEMA.md).

1. **Create a public GitHub repo** and push everything in this folder
   (including the hidden `.github/` directory).
2. **Add the API key secret:** repo → Settings → Secrets and variables →
   Actions → New repository secret → name `ANTHROPIC_API_KEY`.
   Also set a low monthly spend cap in the Anthropic console.
3. **Enable GitHub Pages:** Settings → Pages → Source: "Deploy from a branch" →
   branch `main`, folder `/ (root)`.
4. **Populate events.json:** Actions tab → "Refresh events" → Run workflow.
   Until that first run succeeds, the page automatically shows the always-on
   layer from `recurring.json`, so it's never blank. Review the first few runs
   manually before trusting the Thursday schedule.

Handy while verifying:

- `https://<you>.github.io/<repo>/?data=sample` — view the page against the
  hand-written test fixture instead of live data.
- `node scripts/test-sweep.mjs` — offline test suite for the sweep logic
  (96 checks, no API calls, no dependencies).
- Local preview: run `python3 -m http.server` in the repo folder and open
  `http://localhost:8000/` (opening index.html directly via file:// won't
  fetch the JSON).

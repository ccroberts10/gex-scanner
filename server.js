You reached the start of the range
May 5, 2026, 9:45 PM
npm warn config production Use `--omit=dev` instead.
> gex-scanner@1.0.0 start
> node server.js
[2026-05-06T03:46:51.949Z] · GEX Scanner starting...
[2026-05-06T03:46:51.950Z] · Tradier: ryuuypDW...
[2026-05-06T03:46:51.950Z] · Alpaca:  AKB4QE5Q...
[2026-05-06T03:46:51.950Z] · Pushover: OK
[2026-05-06T03:46:51.952Z] · GEX scheduler started — 8:00am + 9:30am MST weekdays
(node:25) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
[2026-05-06T03:46:51.956Z] · GEX Scanner running on port 8080
Starting Container
[2026-05-06T03:46:56.953Z] · == GEX scan starting (Startup) ==
[2026-05-06T03:46:57.164Z] · Alpaca spot SPY: 723.94
[2026-05-06T03:46:57.476Z] · Spots — SPX: null  SPY: 723.94
[2026-05-06T03:46:57.732Z] ⚠ GEX combination failed — options data unavailable (Tradier down?). CTA and market context will still update.
[2026-05-06T03:46:57.743Z] ⚠ GEX AI recap failed: Cannot read properties of null (reading 'spotPrice')
[2026-05-06T03:46:57.743Z] ✗ runGEXScan: Cannot read properties of null (reading 'spotPrice')
[2026-05-06T03:47:01.952Z] · == CTA refresh starting ==
[2026-05-06T03:47:04.692Z] · == GEX scan starting (Manual) ==
[2026-05-06T03:47:04.880Z] · Alpaca spot SPY: 723.94
[2026-05-06T03:47:04.999Z] · Spots — SPX: null  SPY: 723.94
[2026-05-06T03:47:05.246Z] ⚠ GEX combination failed — options data unavailable (Tradier down?). CTA and market context will still update.
[2026-05-06T03:47:05.246Z] ⚠ GEX AI recap failed: Cannot read properties of null (reading 'spotPrice')
[2026-05-06T03:47:05.246Z] ✗ runGEXScan: Cannot read properties of null (reading 'spotPrice')
[2026-05-06T03:47:05.544Z] ✓ == CTA complete -- score: 17.7 (neutral) | 10/10 assets ==

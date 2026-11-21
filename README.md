# csv-reader-speed-01 — Read broken CSV files faster

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/muhamadyusufseptian6-lab/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/muhamadyusufseptian6-lab/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` returns
exactly csv-reader's answer `{columns, rows, errors}` for every input
`{text, header}` — same BOM handling, CRLF and stray-CR rules, quoted
fields with doubled quotes and embedded line breaks, quote junk,
unterminated quotes, and short/long row padding and cutting — while
reading the text far faster than the reference's one-character-at-a-time
loop.

## How it is fast

- **Whole-line fast path:** a record whose line holds no quote at all is
  split in one go (one slice, one `split(',')`, one scan for stray CRs),
  which covers the large majority of records.
- **Index-based fields:** a record that does hold a quote is read field by
  field, each field found with `indexOf` and sliced whole; only a quoted
  field holding a doubled quote or a line break needs piece-by-piece work.
- **No per-character concatenation** on the hot path, no dependencies, no
  allocation beyond the rows and fields the answer itself needs.
- `main.ts` turns V8's incremental marking off before importing `solve.js`,
  as the house baseline's driver does.

## Speed (practice set, 6 cases, ~10.3 MB of CSV)

- House baseline csv-reader 1.0.0: ~1,509 ms per full run (median wall).
- This entry: ~836 ms per full run (median wall) — about **1.8× faster**.

Parse time alone (steady state, same machine): ~300 ms vs ~800 ms for
the baseline — about **2.7× faster**. The rest of a run is work both
entries share (reading and JSON-parsing the cases, JSON-writing the
answers, Node startup).

Measured locally with Node 24 on this machine; the graded heat runs on the
scored set under the harness. Answers match the reference on all 6 practice
cases, and two runs write byte-identical output.

## Layout

- `solve.js` — the parser: `run(input)` returns `{columns, rows, errors}`.
- `main.ts` — the driver: reads `/input/cases.json`, writes
  `/output/answers.json` (or the `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` directories).

---

Built for the [$100 bounty on make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121) — sign up with my referral code **515temp1** (https://make.fun/r/515temp1) and earn with your own AI agent.

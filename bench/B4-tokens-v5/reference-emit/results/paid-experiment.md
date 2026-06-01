# Reference-Emit Paid Experiment Results

*Run at: 2026-06-01T14:34:32.832Z*
*atoms: crc32c, lru-ttl-cache, avl-tree, dijkstra-heap*
*models: claude-haiku-4-5-20251001, claude-sonnet-4-6*
*reps: 2*
*total cells run: 32 / 32*

## Headline: avg output_tokens per (atom, model)

| atom | model | verbatim_out_tok | reference_out_tok | ratio | ref_behavioral_pass |
|------|-------|-----------------|------------------|-------|---------------------|
| crc32c | claude-haiku-4-5-20251001 | 618.0 | 229.0 | 2.7x | 100% |
| crc32c | claude-sonnet-4-6 | 514.0 | 156.5 | 3.3x | 100% |
| lru-ttl-cache | claude-haiku-4-5-20251001 | 1751.5 | 250.5 | 7.0x | 100% |
| lru-ttl-cache | claude-sonnet-4-6 | 1592.5 | 170.0 | 9.4x | 100% |
| avl-tree | claude-haiku-4-5-20251001 | 2720.5 | 227.0 | 12.0x | 100% |
| avl-tree | claude-sonnet-4-6 | 2697.0 | 139.0 | 19.4x | 100% |
| dijkstra-heap | claude-haiku-4-5-20251001 | 1469.0 | 288.0 | 5.1x | 100% |
| dijkstra-heap | claude-sonnet-4-6 | 2461.5 | 144.0 | 17.1x | 100% |

## Raw cell results

| atom | model | condition | rep | output_tok | input_tok | cache_read | cache_create | actual_usd | behavioral_pass |
|------|-------|-----------|-----|-----------|----------|-----------|-------------|-----------|-----------------|
| crc32c | claude-haiku-4-5-20251001 | verbatim | 0 | 532 | 605 | 0 | 6089 | $0.008701 | true |
| crc32c | claude-haiku-4-5-20251001 | verbatim | 1 | 704 | 605 | 6089 | 0 | $0.003787 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 0 | 254 | 390 | 6089 | 0 | $0.001815 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 1 | 204 | 390 | 6089 | 0 | $0.001615 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 0 | 514 | 605 | 0 | 6090 | $0.032363 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 1 | 514 | 3 | 6090 | 602 | $0.011803 | true |
| crc32c | claude-sonnet-4-6 | reference | 0 | 155 | 390 | 6090 | 0 | $0.005322 | true |
| crc32c | claude-sonnet-4-6 | reference | 1 | 158 | 3 | 6090 | 387 | $0.005657 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 0 | 1764 | 1644 | 6089 | 0 | $0.008858 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 1 | 1739 | 1644 | 6089 | 0 | $0.008758 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 0 | 261 | 408 | 6089 | 0 | $0.001858 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 1 | 240 | 408 | 6089 | 0 | $0.001774 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 0 | 1574 | 1644 | 6090 | 0 | $0.030369 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 1 | 1611 | 3 | 6090 | 1641 | $0.032155 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 0 | 170 | 408 | 6090 | 0 | $0.005601 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 1 | 170 | 3 | 6090 | 405 | $0.005905 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 0 | 2726 | 2785 | 6089 | 0 | $0.013619 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 1 | 2715 | 2785 | 6089 | 0 | $0.013575 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 0 | 214 | 369 | 6089 | 0 | $0.001638 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 1 | 240 | 369 | 6089 | 0 | $0.001742 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 0 | 2697 | 2785 | 6090 | 0 | $0.050637 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 1 | 2697 | 3 | 6090 | 2782 | $0.052723 | true |
| avl-tree | claude-sonnet-4-6 | reference | 0 | 139 | 369 | 6090 | 0 | $0.005019 | true |
| avl-tree | claude-sonnet-4-6 | reference | 1 | 139 | 3 | 6090 | 366 | $0.005293 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 0 | 2473 | 2557 | 6089 | 0 | $0.012425 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 1 | 465 | 2557 | 6089 | 0 | $0.004393 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 0 | 331 | 403 | 6089 | 0 | $0.002134 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 1 | 245 | 403 | 6089 | 0 | $0.001790 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 0 | 2435 | 2557 | 6090 | 0 | $0.046023 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 1 | 2488 | 3 | 6090 | 2554 | $0.048733 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 0 | 144 | 403 | 6090 | 0 | $0.005196 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 1 | 144 | 3 | 6090 | 400 | $0.005496 | true |

## Total spend
$0.4368 across 32 cells

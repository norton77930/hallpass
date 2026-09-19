# Owner comprehension prompts (Q-019 / SC-010)

This is POC owner acceptance only. It is not representative multi-user evidence.

Record the owner's spoken/written answer for every cell. One wrong or ambiguous answer fails that cell.

## Prompts

1. Which current page/origin, product service, and signed-in account does this decision affect?
2. Which exact data categories will leave the Extension, or which exact target/action/text effect will occur, and for what purpose?
3. Is safety `allow` the same as consent, what do deny/unknown mean, and how long does this grant last?
4. Is the task currently waiting, running, stopped, succeeded, denied, cancelled, failed, or attention-required, and can another browser action still start?
5. If an effect is uncertain, what is known, what is not known, and why will the product not retry it?

## Per-cell answers

Copy this block eight times (one per browser/locale/mode cell). Leave blank until the product owner fills it.

```
Cell: Chrome _____ / locale _____ / mode _____
Q1:
Q2:
Q3:
Q4:
Q5:
Owner result: pass / fail
```

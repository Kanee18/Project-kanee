# Animation assets (.vrma)

Drop the character's VRM at `assets/character.vrm` and VRM animation clips in
this folder. Missing files are skipped gracefully (logged once, never a crash,
never a T-pose) — but the character only comes alive with them present.

Expected filenames:

| File           | Used for                              |
| -------------- | ------------------------------------- |
| `idle_01.vrma` | base idle loop (required for idling)  |
| `idle_02.vrma` | idle variation, rotated every 20–40 s |
| `idle_03.vrma` | optional third idle variation         |
| `wave.vrma`    | gesture `[wave]`                      |
| `nod.vrma`     | gesture `[nod]`                       |
| `shake.vrma`   | gesture `[shake]`                     |
| `think.vrma`   | gesture `[think]`                     |
| `clap.vrma`    | gesture `[clap]`                      |
| `bounce.vrma`  | gesture `[bounce]`                    |
| `tilt.vrma`    | gesture `[tilt]`                      |
| `lean_in.vrma` | gesture `[lean_in]`                   |
| `fidget.vrma`  | gesture `[fidget]`                    |
| `peace.vrma`   | gesture `[peace]`                     |

# Animation assets (.vrma)

Drop the character's VRM at `assets/character.vrm`, gesture/idle clips in
this folder, and emote clips in `assets/emotes/`. Missing files are skipped
gracefully (logged once, never a crash, never a T-pose) — but the character
only feels fully alive with them present.

## Base loops (looping clips)

| File               | Used for                                              | Priority |
| ------------------ | ----------------------------------------------------- | -------- |
| `idle_01.vrma`     | base idle loop                                        | REQUIRED |
| `idle_02.vrma`     | idle variation, rotated every 20–40 s                 | high     |
| `idle_03.vrma`     | third idle variation                                  | nice     |
| `talk_01.vrma`     | base loop while SPEAKING (subtle conversational sway) | high     |
| `listening_01.vrma`| base loop while the mic is held (attentive)           | nice     |
| `thinking_01.vrma` | base loop while the reply generates (pondering)       | nice     |

Loop clips must start and end on the same pose, or the loop point will pop.

## Gesture clips (one-shot, triggered by the LLM's tags)

| File           | Tag         | Status                |
| -------------- | ----------- | --------------------- |
| `wave.vrma`    | `[wave]`    | present               |
| `nod.vrma`     | `[nod]`     | present               |
| `shake.vrma`   | `[shake]`   | present               |
| `think.vrma`   | `[think]`   | present               |
| `bounce.vrma`  | `[bounce]`  | present               |
| `peace.vrma`   | `[peace]`   | present               |
| `clap.vrma`    | `[clap]`    | **MISSING — supply**  |
| `tilt.vrma`    | `[tilt]`    | **MISSING — supply**  |
| `lean_in.vrma` | `[lean_in]` | **MISSING — supply**  |
| `fidget.vrma`  | `[fidget]`  | **MISSING — supply**  |

Missing tags are silently skipped, so the LLM "gestures" with nothing —
filling these four directly improves how well motion matches speech.

Gesture clips should START and END near a relaxed standing pose (arms low):
they crossfade with the idle, so a clip authored from a T-pose or an extreme
stance will lunge at the boundaries.

## Extras

| File                   | Used for                          |
| ---------------------- | --------------------------------- |
| `thankful.vrma`        | idle fidget + talk gesture pool   |
| `thoughtful_nod.vrma`  | idle fidget pool                  |
| `spin.vrma`            | idle fidget pool                  |
| `../emotes/*.vrma`     | emote button clips (full body)    |

---
paths:
  - "static/**"
---

# Frontend rules

- Plain HTML, CSS and JavaScript. No npm, no bundler, no build step.
- Call the server through `api()` in `app.js`. It turns a network failure into a readable message.
- Escape any text that goes into `innerHTML` with `esc()`.
- Change the speaker selection only through `toggleSpeaker()` and `syncGroup()`. The selection mirrors the group Sonos reports, and `adoptActualGroup()` keeps it that way.
- Use `127.0.0.1`, not `localhost`, in any address the page builds.
- Colours come from CSS variables. The accent colour is set at runtime from the cover art.

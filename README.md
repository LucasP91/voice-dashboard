# Voice Dashboard

A voice-controlled touch dashboard for an iPad, hosted as a static site on GitHub Pages.
It uses the same Aurora background and colours as the portfolio site.

- **Widgets:** to-do list, clock, timer, weather (Open-Meteo, no key), note, checklist.
- **Voice:** tap the mic and speak (Safari's built-in speech recognition). GitHub Pages is HTTPS, so the mic just works.
- **Claude (optional):** Settings → paste an Anthropic API key and any request is understood. Without a key a built-in parser handles the common phrases.
- **Storage:** widgets and the key live in the iPad's browser storage (`localStorage`). Nothing personal is in this repo.

## Things to say

| Say | Does |
|---|---|
| "Add milk to my to-do list" / "Add eggs, bread to the to do list" | Adds tasks (commas split them) |
| "Remind me to call the dentist" | Adds a task |
| "Tick off milk" / "I finished the laundry" | Ticks a task |
| "Remove milk from my to-do list" | Deletes a task |
| "Clear the completed tasks" | Deletes ticked tasks |
| "Set a timer for 10 minutes", "Weather in London", "Add a clock", "Note: …" | Other widgets |
| "Remove the clock", "Clear the dashboard" | Removes widgets |

## Develop

```powershell
npm run dev    # preview at http://localhost:5180
npm test       # parser + action tests
```

Pushing to `main` runs `.github/workflows/pages.yml`: the tests run, then only `index.html`, `app.js`, `logic.js` and `style.css` are published.

## iPad setup

1. Open the Pages URL in Safari and allow the microphone when asked.
2. Share → **Add to Home Screen** (opens full screen, no browser bars).
3. Optional: Settings → Display & Brightness → Auto-Lock → Never; Accessibility → Guided Access to lock it to the dashboard.
4. On an older iPad, switch off "Animate the background" in Settings if it runs warm.

## About the Claude key

The key is typed on the device and stored only in that browser. It is sent straight to `api.anthropic.com`
(using Anthropic's browser-access header) and never to GitHub. Anyone using that iPad can use the key,
so set a monthly spending limit in the Anthropic Console.

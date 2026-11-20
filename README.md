# Voice Dashboard

A voice-controlled touch dashboard for an iPad, hosted as a static site on GitHub Pages:
**https://lucasp91.github.io/voice-dashboard/**. It uses the same Aurora background and colours as the portfolio site.

- **Widgets:** to-do list, clock, timer, weather (Open-Meteo, no key), note, checklist.
- **Voice:** tap the mic and speak (Safari's built-in speech recognition). GitHub Pages is HTTPS, so the mic just works.
- **Claude (optional):** Settings → paste an Anthropic API key and any request is understood. Without a key a built-in parser handles the common phrases.
- **To-do sync (optional):** connect a Google Sheet so Claude Duet can add and tick your tasks. See below.
- **Storage:** widgets and keys live in the iPad's browser storage (`localStorage`). Nothing personal is in this repo.

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

## Google Sheet sync (Claude Duet)

The to-do list can live in a Google Sheet instead of only on the iPad. Claude Duet edits the sheet's rows;
the dashboard reads them every minute (and whenever you open it) and writes your ticks and new tasks back.

The sheet looks like this. Row 1 is the header; Done can be a checkbox, `TRUE`, or `x`:

| Task | Done |
|---|---|
| Buy milk | ☐ |
| Call the dentist | ☑ |

### Setup (about 5 minutes, once)

1. **Make the sheet.** Go to [sheets.new](https://sheets.new) and name it **Dashboard To-do**.
2. **Add the script.** In the sheet: **Extensions → Apps Script**. Delete what's there, paste all of
   [`apps-script/Code.gs`](apps-script/Code.gs), and save (💾).
3. **Make the secret.** In the function menu at the top choose **setup**, press **Run**, and allow access when Google asks
   (it's your own script, so choose your account → Advanced → Go to project). Open **Execution log**: copy the line
   `Dashboard secret: …`. The script also adds the Task / Done header to the sheet.
4. **Publish it.** **Deploy → New deployment →** gear icon **→ Web app**. Execute as: **Me**. Who has access: **Anyone**.
   Press **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. **Connect the iPad.** On the dashboard: **Settings → Google Sheet to-do sync**, paste the URL and the secret, **Save**.
   Tasks already on the iPad are copied into the sheet.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

**Why "Anyone"?** Safari can't sign in to Google from the dashboard, so the web app has to be reachable without a login.
Every request must carry the secret, and the script can only add, tick, untick and remove rows in this one sheet.
Keep the URL and secret private; to revoke them, run `setup` after deleting the `SECRET` script property
(Project Settings → Script properties), or archive the deployment.

### Tell Claude Duet

Send Duet something like:

> My dashboard's to-do list is the Google Sheet **"Dashboard To-do"**. Row 1 is the header (Task, Done); each task is one row
> with its text in column A and a checkbox in column B. When I ask you to add a to-do, append a row with the Done box unticked.
> To finish one, tick its box; to delete one, delete the row. Don't change the header or other columns, and only add
> tasks you find in my email or calendar after I say yes.

## Develop

```powershell
npm run dev    # preview at http://localhost:5180, with a mock sheet at /mock-sheet (secret: test-secret)
npm test       # parser, actions, Apps Script and sheet-client tests
```

Pushing to `main` runs `.github/workflows/pages.yml`: the tests run, then only `index.html`, `app.js`, `logic.js` and `style.css` are published.

## iPad setup

1. Open the Pages URL in Safari and allow the microphone when asked.
2. Share → **Add to Home Screen** (opens full screen, no browser bars).
3. Optional: Settings → Display & Brightness → Auto-Lock → Never; Accessibility → Guided Access to lock it to the dashboard.
4. On an older iPad, switch off "Animate the background" in Settings if it runs warm.

## About the keys on the iPad

The Claude key and the sheet secret are typed on the device and stored only in that browser. The Claude key goes straight to
`api.anthropic.com` (using Anthropic's browser-access header) and the secret only to your Apps Script; neither is ever on GitHub.
Anyone using that iPad can use them, so set a monthly spending limit on the Claude key in the Anthropic Console.

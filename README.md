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
| "Move the clock to the top", "Put the to-do list at the end", "Move the weather left" | Reorders cards |
| **"Duet, …"** / "Hey Duet, …" (anything after it) | Leaves a question or request for Claude Duet; the answer appears on the Duet card |

Cards can also be moved by dragging the ⠿ handle, or by tapping it for ◀ ▶ buttons.

**Add a card**, under the cards, lists what you can still add. To-do and Duet appear only while they're not on the
dashboard. Clock and 5-minute timer are added straight away. Weather, Note and Checklist start the command in the box
below so you can type or say the rest.

### "Duet, …"

Like talking to Siri: start with **"Duet,"** and the rest goes to Claude Duet through the Google Sheet's **Questions** tab.
Duet runs on your Claude subscription, so this never uses API tokens. It isn't instant: Duet answers when it checks the
sheet (on its schedule, or when you tell it to in the Duet app), and the answer then shows on the dashboard's Duet card.

## Google Sheet sync (Claude Duet)

The to-do list can live in a Google Sheet instead of only on the iPad. Claude Duet edits the sheet's rows;
the dashboard reads them every minute (and whenever you open it) and writes your ticks and new tasks back.

The sheet looks like this. Row 1 is the header; Done can be a checkbox, `TRUE`, or `x`:

| Task | Done |
|---|---|
| Buy milk | ☐ |
| Call the dentist | ☑ |

A second tab, **Questions**, is created by the script and holds what you say after "Duet,":

| Question | Asked | Answer | Answered |
|---|---|---|---|
| What should I cook tonight? | 2026-11-21 18:02 | A stir-fry with the leftover chicken… | 2026-11-21 19:30 |

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

### Updating the script

When `Code.gs` changes (for example, the "Duet, …" Questions tab was added after the first setup):

1. In the sheet: **Extensions → Apps Script**, replace everything with the new [`apps-script/Code.gs`](apps-script/Code.gs), save.
2. **Deploy → Manage deployments →** pencil (Edit) **→ Version: New version → Deploy.**
   This keeps the same URL, so nothing changes on the iPad. Don't use *New deployment*, which makes a new URL.

Until the script is updated, "Duet, …" questions wait on the dashboard's Duet card and go through afterwards.

**Why "Anyone"?** Safari can't sign in to Google from the dashboard, so the web app has to be reachable without a login.
Every request must carry the secret, and the script can only add, tick, untick and remove rows in this one sheet.
Keep the URL and secret private; to revoke them, run `setup` after deleting the `SECRET` script property
(Project Settings → Script properties), or archive the deployment.

### Tell Claude Duet

Send Duet something like:

> My dashboard uses the Google Sheet **"Dashboard To-do"**.
>
> **To-do tab (the first tab):** row 1 is the header (Task, Done); each task is one row with its text in column A and a
> checkbox in column B. When I ask you to add a to-do, append a row with the Done box unticked. To finish one, tick its box;
> to delete one, delete the row. Don't change the header or other columns, and only add tasks you find in my email or
> calendar after I say yes.
>
> **Questions tab:** these are things I said to you from my dashboard. Whenever you check in, and whenever I ask you to,
> look for rows with an empty **Answer** (column C). Answer each one as if I'd asked you directly, write the answer in
> column C, and put the date and time in **Answered** (column D). Keep answers short enough to read on an iPad (a few
> sentences or a short list). If a row asks you to do something, do it the way you normally would, asking me first before
> anything consequential, and use the Answer to say what you did. Don't edit the Question or Asked columns.

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

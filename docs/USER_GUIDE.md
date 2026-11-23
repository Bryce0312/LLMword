# Stock Prediction Studio: User Guide

This guide covers the current **V4.4** interface. Stock Prediction Studio turns a stock question into a documented investigation: a lead agent selects researchers, researchers retrieve public sources, and the lead agent compares their reports before publishing a yes/no forecast. You can inspect the evidence, disagreements and limits behind that forecast.

For installation options and the project's current limits, see the [README](../README.md). A forecast probability is an estimate for a particular question, not an investment recommendation or a measure of the model's accuracy.

## 1. Open the app and choose English

If the local service is not already running, install Node.js 22.17 or later, open a terminal in the project folder, and run:

```bash
npm ci
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). Keep the service running while researching or monitoring. The default address opens the welcome page; a saved link to a particular task opens that task directly.

Select **English** at the right end of the top bar **before starting a new prediction**. The language selected at creation becomes that task's report language, including retries and later checks. Switching the interface afterward does not translate an existing report. Original questions, quotations, source text and custom researcher names retain their original language.

You can read the welcome page, tutorials and saved records without configuring a model key. Live investigations require your own model connection.

## 2. Try a tutorial without calling a model

On the welcome page, choose **See the tutorial first**, or scroll to the three tutorial cards:

| Path | What to look for |
| --- | --- |
| **Full collaboration: from assignment to forecast** | How tasks, independent reports, citations and the final decision fit together. |
| **Targeted re-check: reopen only what changed** | Why new evidence can trigger a limited follow-up, and why duplicate sources do not count as independent evidence. |
| **Failure and recovery: keep the failure record, then collaborate again** | How a failed run remains visible when a later run succeeds. |

Choose **Start**, follow the chapter links, and select **Finish this path** at the end. Expand the full archived collaboration record when you want to inspect details. **Continue** resumes a partly visited path; **Review again** reopens a completed path.

Tutorials read local simulated/replay archives. They create no live tasks, make no model calls and do not write to live prediction history. The example probabilities illustrate the workflow, not real performance. Tutorial progress stays in this browser and is reset if its stored data is cleared.

On a completion page, you can edit the example question and select **Start a live prediction**. This only fills the live form; review it and press **Start prediction** yourself. An archived example may remain in its original language even when the interface is English.

To proceed directly, choose **Enter the research room** on the welcome page.

## 3. Connect your model

In the research room, open **Model connection**. The form's field labels remain **DeepSeek API Key**, **DeepSeek URL** and **DeepSeek model**, including for a compatible campus or custom endpoint.

1. Enter the key issued for the endpoint you will use.
2. Set the **full chat-completions URL** and the exact model name. The URL field offers these presets and also accepts a custom compatible URL:

   | Connection | Full URL | Model preset |
   | --- | --- | --- |
   | Official DeepSeek, the default | `https://api.deepseek.com/chat/completions` | `deepseek-flash` |
   | Campus | `https://genai.comp.polyu.edu.hk/api/v1//chat/completions` | `DeepSeek-V4-Flash` |

3. Select **Save for future tasks** and read the result beneath the form.
4. If necessary, select **Refresh connection status** to read the current saved state.

Choosing a preset URL also fills its matching model name; confirm that both match your account. For a custom endpoint, use the full URL supplied by its operator, without credentials or query parameters in the URL. **Restore defaults** fills the official defaults and clears the input; it does not apply them until you enter a key and save.

**API Key connected** means the endpoint's `/models` credential check passed. Saving does not start a forecast or send a model-generation request. A successful check does not establish that your balance, selected model permissions, search access or document retrieval will support a whole investigation. **API Key configured; not connected** means settings were saved but verification failed; correct the key, permissions or network and save again.

### Model access and source access are separate

An official DeepSeek key can be used for both the model and the official search/page-reading service. A campus or custom model key is used for that model endpoint; it is **not forwarded to the official source service**. For those connections, the person running the server must separately configure the official source credential as `WORLD_SEARCH_API_KEY` in the server environment. See [Configuration reference](#configuration-reference) and the [README connection instructions](../README.md#model-and-information-service-setup).

The app can therefore show a verified model connection while official search and page reading remain unconfigured. Check the displayed source status and the actual tool results. Model and source services may have separate charges; a token budget is not a currency spending limit.

### What happens to your key

| Action | Effect |
| --- | --- |
| Submit the connection form | The password input is cleared while sending. After verified success, the entered key returns as editable password dots. A failed verification leaves the input empty. |
| Switch operation windows in the same page | The locally verified, masked input can be restored while the saved connection is unchanged. |
| Fully refresh or reopen the page | The input is not refilled. The running server can still hold its session connection; an empty field alone does not mean it is disconnected. |
| Restart the server | A key saved through the web form must be entered again. Credentials supplied through the startup environment are loaded separately. |

The browser keeps the verified input only in the current page's memory, not in local storage or session storage. The server holds a web-saved key for its current process, does not write it to project files, and does not return it through the status endpoint.

Before replacing an existing connection, stop tasks that are running, queued or actively monitoring, then refresh the connection status. Otherwise the save is rejected and the previous connection remains. A task paused by a provider failure with no next wake-up does not need to be stopped: fix the connection, then retry that task manually. Saving a key does not automatically retry failed investigations.

## 4. Start your first prediction

Choose **Start prediction** in the top menu.

1. Enter a stock, security or fund with enough detail to identify it. For example: **“Will Tencent Holdings (00700.HK) rise over the selected forecast horizon?”** A ticker plus market is clearer than a company name alone.
2. Choose **1, 3, 5 or 20 trading days** under **Forecast horizon**. The default is **5 trading days**.
3. For a first investigation, leave **Continuous forecasting** unchecked.
4. Confirm that the interface is **English**, then select **Start prediction**. This starts live model and source work and can use your provider account's quota.

The horizon starts with the next trading date after the task's creation date and ends at the close of the selected trading day. The app uses the relevant market calendar and excludes its recorded holidays. Tickers and explicit markets take priority; recognized US names such as NVIDIA or Apple can suggest the US calendar. Otherwise, Hong Kong is the default. Calendar selection does not by itself verify the security's identity.

Open **Prediction results and progress** in the pixel room. Check the interpreted question, fixed deadline, resolution rule, default assumptions and recent reference. Expand **View assumptions and recent reference** or **Expand all** when offered. If the interpretation or market is wrong, choose **Revise and create a new prediction**, edit the form and submit a new task. This preserves the earlier task's record; it does not cancel any earlier monitoring you left active.

### Optional continuous forecasting

Checking **Continuous forecasting** when creating a task allows the server to check for new information periodically, normally once an hour unless the server operator changes the interval. The server must stay running. Checks may call the model and source services again.

The system compares new information with saved evidence and may keep the previous judgment, reopen selected researchers, or call the team for review. A scheduled check does not automatically produce a new probability. The monitoring section shows the saved schedule and latest triage; provider failures can pause monitoring until you act.

## 5. Inspect the investigation and read the result

The room's characters and progress reflect saved execution events. The lead agent selects a team for the question; the ten available roles do not all participate in every run. Worker cards show each selected researcher's assignment, selection reason and status. A **Waiting for model** state is a pending request, not a completed finding. The overall progress percentage represents workflow milestones, not forecast confidence.

In **Prediction results and progress**, use these sections:

| Section | How to use it |
| --- | --- |
| **How this round works** | Check the current phase, researcher statuses and recorded model/tool/token usage. Missing usage is not zero and may mean the displayed figures are not a complete bill. |
| **Current probability forecast** or **Price direction probabilities** | Read the exact question and what Yes means, together with the deadline, rule, baseline, evidence adequacy and scoring status. |
| **How collaboration influenced the forecast** | Expand researcher reports to see assignments, summaries, support, counterevidence, citations, quotations and unresolved gaps. Read whether the lead agent adopted, qualified or rejected their findings. |
| **Sources and relationships** | Inspect saved source text, source links, publication/retrieval times and support or contrary relationships. A search hit alone does not establish that the full source was read. |
| **Public collaboration records** | Expand the selected round's saved assignments, tool calls, matched returns, failures and public summaries. These are public records, not hidden model reasoning. |
| **How the forecast changes** | Inspect published probability points and their summaries. Future space stays blank; checks, waiting states and outcomes do not become invented forecast points. |

**Yes** means the event stated in the question. In a question about a decline, Yes can mean a decline. **No** is its complement. Read the rule before interpreting either number.

Probability, evidence adequacy and agreement are separate. A high estimate can still rest on limited evidence. A result marked as a preliminary conditional estimate or **Not scored** must be read with its assumptions and missing benchmark. When no valid probability has been published, the app leaves it missing rather than substituting 0% or 50%. A provisional direction is not a probability forecast. A budget closeout can show a labeled aggregation of researcher estimates while the lead agent's final decision remains incomplete; read that limitation before treating it as a finished judgment.

Some saved fixed-rule cases show a **Verify the outcome** section. When enabled, select **Read and verify the official outcome** and follow the displayed rule and observation window. General automatic expiry scoring for ordinary stocks is not implemented. Outcome records remain separate from the original forecast; a single Brier score does not establish overall accuracy. The **Learning archive** contains resolved forecast/outcome lessons, not every completed research report, and does not train model weights.

## 6. Continue, stop or recover a task

| Control | What it does |
| --- | --- |
| **Check for new information** | Requests another live check for the same question when eligible. It can consume quota even if no new forecast is published. |
| **Retry this research** | Starts another investigation after a failure, preserving the question, fixed deadline, prior runs and any published judgment. Fix the reported problem first. |
| **Stop monitoring** | Stops this task's ongoing/queued work and future monitoring. Saved evidence and forecasts remain. A stopped task cannot be restarted with the check button; create a new prediction to research it again. |
| **Revise and create a new prediction** | Copies the question and relevant choices into an editable new-task form. Review and submit it yourself. |

Checks and retries are unavailable while an investigation is already active, after the forecast deadline, after an outcome is recorded, or for a stopped task. The disabled control's explanation tells you why. In particular recovery cases, the app may instead offer an action to continue summarizing saved reports; use the offered action without assuming every task supports summary-only recovery.

Refreshing the browser restores saved state. It is not a request to rerun a failed investigation. When a provider failure pauses monitoring, read the error, restore the relevant model/source access, and select **Retry this research** manually. A new successful run keeps the earlier failure record.

## 7. Reopen, export or remove history entries

1. Open **Prediction history** in the top menu and choose the question you want. Saved history opens its result/progress panel.
2. Use **Displayed round** to select a particular run. **View the forecast research process** selects the run that produced the current answer; **View the latest monitoring check** selects the most recent check when available. These can be different runs. Selecting a historical round keeps the room on that choice when newer work arrives.
3. In **How collaboration influenced the forecast**, choose **Export this round's collaboration** to download that selected run's public collaboration JSON. It is a run-level export, not a backup of the entire local database.
4. If an eligible history entry offers **Delete record**, select it and confirm the named question. Refresh history if the entry changed while you were viewing it.

Deletion removes the entry from the history list; it does not physically erase original runs, judgments or evidence. Active work, monitoring and outcome verification are protected. The current interface offers deletion for eligible forecast, insufficient-evidence and failed entries; it does not offer it for every record, including stopped tasks or financial research reports.

## 8. Adjust settings for later tasks

Open **Lab settings** and find **Token budget per prediction**. New predictions default to **Limited: 1,000,000 tokens**. Choose a preset or enter a positive whole number, then select **Save budget**. The saved change applies only to newly created prediction tasks.

**Unlimited** removes the overall token cap; individual outputs, request counts, local budgets and timeouts remain limited. Displayed model prices depend on the connected endpoint and available pricing information. Unavailable prices do not mean the service is free.

The same page lists researcher seats and their responsibilities, instructions, tools and saved versions. You do not need to customize them to start. Changes are versioned so old runs keep their earlier definitions. New predictions require at least three distinct available roles and the original verification role; deleting required seats can prevent them from starting.

## Configuration reference

The web form is sufficient for normal model setup. For startup configuration, copy [`.env.example`](../.env.example) to `.env` locally and fill in the settings you need. `npm start` does **not** automatically load that file. To load it explicitly, run this from the project folder:

```bash
node --env-file=.env start-live.mjs
```

| Setting | Purpose |
| --- | --- |
| `WORLD_API_KEY` | Model credential loaded at startup. |
| `WORLD_CHAT_COMPLETIONS_URL` | Full chat URL; takes priority over `WORLD_BASE_URL`. |
| `WORLD_MODEL_NAME` | Exact model identifier for that endpoint. |
| `WORLD_SEARCH_API_KEY` | Separate official source-service credential, particularly for a campus/custom model connection. |
| `WORLD_COURSE_POLL_MS` | Continuous-check interval in milliseconds; default `3600000` (one hour). |
| `PORT` | Local port; default `4174`. |
| `WORLD_DATA_DIR` | Separate data directory; default `.data/live/`. |

Keep real keys out of source files, screenshots and commits. Use one server instance per data directory. For a separate local instance on Windows PowerShell, set `$env:PORT = '4196'` and `$env:WORLD_DATA_DIR = '.data/live-b'`, then run `npm start`. Stop that instance before reusing its data directory.

## 9. Troubleshooting

| Symptom | Next step |
| --- | --- |
| **Start prediction** is unavailable | Check **Model connection**. If the page asks for a restart after an update, restart this local service and select **Check the service again**. |
| The page says data is disconnected | Confirm the local service is still running at the address you opened, then retry reading. A page/server connection is different from a model connection. |
| Model connection passes, but search or page reading fails | Check source-service credentials, permissions and balance separately, especially with a campus/custom model URL. Inspect the failed tool's record. |
| Balance, authentication or access error | Restore the account quota or correct the relevant service key/permissions, then retry manually. Repeatedly refreshing the page does not fix these errors. |
| Rate limit, timeout or network interruption | Follow the error's guidance, allow any displayed retry interval, then retry manually after the service/network recovers. |
| Model output is incomplete | Check the provider's output/context configuration before retrying; the same settings may truncate again. Saved partial material does not establish a final forecast. |
| Saving a replacement key is rejected as busy | Stop running, queued or actively monitoring tasks, refresh connection status, re-enter the key and save. Provider-paused tasks without a scheduled wake-up can be retried after updating the connection. |
| A report is still in another language | Report language was fixed when its task began. Choose English before creating a new task. Source quotations and archived records retain their original language. |
| No probability or chart point appears | Inspect the status, evidence gaps and failure message. A check with no new judgment correctly leaves the prior probability unchanged. |
| A tutorial cannot load its archive | From the project folder, run `npm run cases`, then reload the tutorial. This generates local demonstration cases, not live predictions. |

Keep the local data directory when restarting: saved tasks and evidence are stored under `.data/live/` by default. Browser tutorial progress and web-session model credentials have the separate lifecycles described above.

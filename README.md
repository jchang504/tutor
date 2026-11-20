# Taiwanese Mandarin Driving Tutor · Hands-Free Voice SRS

A hands-free, eyes-free **Taiwanese Mandarin** (`繁體中文`) vocabulary and conversational sentence tutor built for practicing out loud while driving, walking, or wearing Bluetooth earbuds.

- **Real-Time Native Audio Tutor (Gemini Live API):** Reads an everyday English prompt out loud, listens to your Mandarin translation, carefully coaches your **pronunciation, tones, and natural Taiwan phrasing** until you say the complete sentence naturally, then asks one conversational follow-up question and coaches your reply before moving on.
- **Fresh Sentences Every Review:** Automatically generates a brand-new everyday Taiwanese Mandarin sentence and English prompt after every word you practice, so you use each word in varied real-life contexts over time.
- **FSRS v5 Spaced Repetition in Your Own Google Sheet:** Tracks stability, difficulty, due dates, and full review logs directly inside a Google Sheet you own (`Vocab`, `ReviewLog`, and `Settings` tabs).
- **In-Car & Bluetooth Ready:** Routes audio cleanly over Bluetooth hands-free / earbuds (falling back to phone speakerphone indoors), keeps the screen awake (`Wake Lock`), and supports car steering-wheel / earbud **Previous** (restart current word) and **Next** (skip word) buttons.

---

## Quick Tryout (30 Seconds — No Setup Required)

Want to test the voice tutor before creating a Google Sheet?
1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Open **[https://jchang504.github.io/tutor/](https://jchang504.github.io/tutor/)** in Chrome on your phone or computer.
3. Tap **Settings** (top right) → scroll down to **Optional: Direct Gemini API Key**, paste your key, and tap **Save Settings**.
4. Tap **Start Driving Session** to practice right away with the built-in 5-word Taiwanese Mandarin sample deck.

---

## Full Setup Guide (Use Your Own Google Sheet, Apps Script & Gemini API Key)

Anyone can use the hosted app at **[https://jchang504.github.io/tutor/](https://jchang504.github.io/tutor/)** with **their own private Google Sheet and Gemini API key**—your Web App URL and secret passphrase are stored *only* in your own browser's `localStorage` and are never shared with anyone else. *(If you prefer to host your own copy, see [Optional: Host Your Own GitHub Pages Copy](#optional-host-your-own-github-pages-copy) below.)*

### Step 1: Get a Gemini API Key
1. Go to **[Google AI Studio — API Keys](https://aistudio.google.com/apikey)** and sign in with your Google account.
2. Click **Create API key** and copy the key (starts with `AIza...`).
   - *Tip:* Linking a billing account in Google AI Studio (Pay-as-you-go Tier 1) is recommended so Gemini Live audio sessions don't hit free-tier rate limits; typical personal voice practice costs only a few cents per session.

### Step 2: Create Your Google Sheet & Apps Script Backend
1. Create a brand-new blank Google Sheet at **[sheets.new](https://sheets.new)** and name it something like **`Mandarin Tutor SRS`**.
2. In the top menu of your Google Sheet, click **Extensions → Apps Script**.
3. In the Apps Script editor (`Code.gs`), delete the placeholder `function myFunction() {}` code, paste the **entire contents** of [`apps-script/Code.gs`](./apps-script/Code.gs) from this repository, and click **Save (💾)** (`Ctrl+S` / `Cmd+S`).
4. Add your API key and a personal secret in **Script Properties**:
   - In the left sidebar of Apps Script, click **Project Settings (⚙️)**.
   - Scroll to the bottom section **Script Properties** and click **Add script property**.
   - Add these **two exact property names**:
     - **`GEMINI_API_KEY`** → paste your `AIza...` key from Step 1.
     - **`BACKEND_SECRET`** → invent any secret password/passphrase (for example, `taiwan-mandarin-secret-9876`). You will enter this same passphrase in the web app so only you can access your Sheet.
   - Click **Save script properties**.
5. Initialize the Sheet tabs once:
   - Click **Editor (`< >`)** in the left sidebar to return to `Code.gs`.
   - In the top toolbar dropdown (next to **Debug**), select **`setupSheet`** and click **Run**.
   - Google will ask you to authorize your script: click **Review permissions** → choose your Google account → click **Advanced** → **Go to Untitled project (unsafe)** *(this warning appears because you wrote/pasted the script yourself)* → click **Allow**.
   - Check your Google Sheet: you will now see three formatted tabs: **`Vocab`**, **`ReviewLog`**, and **`Settings`**.
6. Deploy as a Web App:
   - In the top right of Apps Script, click **Deploy → New deployment**.
   - Click the gear icon (**⚙️**) next to **Select type** and choose **Web app**.
   - Set **Execute as:** `Me`
   - Set **Who has access:** `Anyone` *(Why `Anyone`? This allows the browser app to send `POST` requests without Google OAuth popups; `Code.gs` rejects any request that does not carry your `BACKEND_SECRET`.)*
   - Click **Deploy** and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).

### Step 3: Connect the Web App on Your Phone
1. Open **[https://jchang504.github.io/tutor/](https://jchang504.github.io/tutor/)** in **Chrome** on Android (or Safari on iPhone / Chrome on desktop).
   - *Optional:* Tap Chrome's menu (**⋮**) → **Add to Home screen / Install app** so it launches full-screen like a native app.
2. Tap **Settings** in the top right and fill in:
   - **Google Apps Script Web App URL:** paste the `https://script.google.com/macros/s/.../exec` URL from Step 2.
   - **Personal Backend Secret (`BACKEND_SECRET`):** enter the exact secret passphrase you created in Step 2.
   - Choose your **Default TOCFL Level** (Level 1 = Beginner, Level 2 = Basic, Level 3 = Intermediate, etc.) and **Tutor Voice**.
3. Tap **Test Sheet Connection** (you should see *"Connected!"*) and then tap **Save Settings**.

### Step 4: Add Vocabulary & Start Practicing
You have two easy ways to populate vocabulary—and you can combine both:

- **Option A — Automatic Taiwan TOCFL Vocabulary (Zero Files Needed):**
  - Simply tap **Start Driving Session**! Whenever your Sheet needs new words, it automatically pulls high-frequency spoken Taiwanese Mandarin vocabulary for your chosen TOCFL level from [`PSeitz/tocfl`](https://github.com/PSeitz/tocfl) (sorted by spoken frequency) and generates natural Mandarin + English sentences.
  - Or tap **Vocab** in the top bar → scroll to **2. Supplement from Official Taiwan NAER / TOCFL Dataset** → choose a TOCFL Level and word count → tap **Pull TOCFL Words** to pre-load words into your Sheet ahead of time.
- **Option B — Import Your Own AnkiDroid / Hanping Word List:**
  - Export your deck from Anki / AnkiDroid as **Notes in Plain Text (`.txt`)** (check **Include tags** if you want to filter by a tag) or export a CSV/TSV word list from Hanping Chinese Dictionary.
  - Tap **Vocab** in the top bar → select your `.txt` / `.csv` file → optionally pick a tag filter → tap **Import Filtered Notes & Pre-Generate Sentences**.
  - You can also simply type or paste Traditional Chinese words directly into the `Vocab` tab of your Google Sheet (put a unique ID in column `A`, Traditional Chinese in column `B`, Pinyin in column `D`, English meaning in column `F`, and `new` in column `K` `status`, then click **Mandarin Tutor → Generate Missing Mandarin -> English Sentences** in your Google Sheet's top menu).

---

## How a Practice Session Works

1. **Translate the English Prompt:** The tutor reads an English sentence at normal speed and invites you to translate it into Mandarin. The target word is masked (`•••`) on screen so you recall it by ear.
2. **Native-Speaker Coaching Loop:**
   - If you use a valid synonym (e.g., `平常` when the target card is `經常`), the tutor affirms your natural sentence and nudges you to try today's target synonym **without** spoiling its pronunciation or docking your score.
   - If any tone, pronunciation, measure word, or grammar sounds non-native—or if you use an English word—the tutor points out the specific fix and waits for you to say the **complete corrected sentence** before moving on. *(Corrections on words other than the target word never hurt your FSRS score for the target word!)*
3. **Follow-Up Question:** Once your translation is natural, the tutor asks **one** everyday follow-up question in Mandarin (naturally incorporating the target word) and coaches your spoken answer until natural, then responds with a brief acknowledgment and advances to the next word.
4. **Hands-Free Controls:**
   - **Car Steering Wheel / Earbuds:** **Next** skips to the next word; **Previous** restarts the current word from the beginning; **Play/Pause** pauses or resumes.
   - **On-Screen Buttons:** **✓ Done Speaking** (or tapping the central **VOICE** orb) commits your turn immediately; **Repeat** replays only the tutor's last prompt; **Hint** asks for a clue; **Skip** moves to the next word.
   - **Spoken Commands:** Say `"再說一次"` / `"Repeat"` to hear the last prompt again, `"跳過"` / `"下一題"` to skip, `"暫停"` to pause, or `"結束練習"` to end the session.

---

## Optional: Host Your Own GitHub Pages Copy
1. Fork this repository on GitHub.
2. Go to your fork's **Settings → Pages** and set **Build and deployment → Source** to **Deploy from a branch**, selecting **`gh-pages`** and **`/ (root)`**.
3. Open `https://<your-github-username>.github.io/<repo-name>/` and follow Steps 1–4 above.

### Updating `Code.gs` Later
If you ever paste an updated version of [`apps-script/Code.gs`](./apps-script/Code.gs) into your Apps Script project:
1. Click **Save (💾)** in Apps Script.
2. Click **Deploy → Manage deployments** → click the **Edit (✏️)** icon → change **Version** to **`New version`** → click **Deploy** *(this updates your live script while keeping your Web App URL unchanged)*.

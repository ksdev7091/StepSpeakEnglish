const $ = (id) => document.getElementById(id);

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canListen = Boolean(Recognition);
const canSpeak = "speechSynthesis" in window;

// 話し終わったとみなすまでの無音時間。初心者ほど文を考える間が長いので余裕を持たせる
const SILENCE_MS = [4000, 3500, 3000, 2600, 2200];
const CONFIRM_MS = 3500; // style.css の .countdown と合わせる
// 復習の間隔(日)。言えるたびに次の間隔へ進む
const INTERVALS = [1, 3, 7, 14, 30];
const NOTEBOOK_MAX = 300;

// ---- 保存データ ----------------------------------------------------------

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // プライベートブラウズなどで保存できなくても動作は続ける
  }
}

const settings = { level: 2, showText: null, handsFree: false, rate: 0.85, ...read("sse-settings") };
const stats = { turns: 0, sessions: 0, days: [], cleared: {}, ...read("sse-stats") };
// 復習リスト: { en, ja, said?, box, due }
let notebook = Array.isArray(read("sse-notebook")) ? read("sse-notebook") : [];

function dayString(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("sv");
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 直された表現や覚えたいフレーズを復習リストに入れる。追加できたら true */
function addNote({ en, ja, said }) {
  const key = normalize(en || "");
  if (!key || notebook.some((n) => normalize(n.en) === key)) return false;
  notebook.push({ en, ja: ja || "", said: said || "", box: 0, due: dayString(1) });
  notebook = notebook.slice(-NOTEBOOK_MAX);
  save("sse-notebook", notebook);
  return true;
}

function dueNotes() {
  const today = dayString();
  return notebook.filter((n) => n.due <= today);
}

/** 文字を表示するかどうか。本人が設定していなければ Step 1〜2 だけ最初から表示する */
function showTextByDefault() {
  if (!canSpeak) return true;
  return settings.showText ?? settings.level <= 2;
}

// ---- 状態 ----------------------------------------------------------------

let config = { levels: [], scenarios: [] };
let scenario = null;
let messages = []; // { role, text, ja?, feedback?, shown?, jaShown? }
let hints = [];
let goalsDone = new Set();
let focus = [];
let mode = "idle"; // idle | listening | confirm | thinking | speaking
let pending = null; // 送信待ちの聞き取り結果 { text, lang }
let confirmTimer;
let recognition = null;
let speakToken = 0;
let retry = null;
let practice = null; // { queue, retried, heard, match, revealed }

// ---- 音声 ----------------------------------------------------------------

function englishVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").startsWith("en"));
  const score = (v) =>
    (v.lang.replace("_", "-") === "en-US" ? 4 : 0) +
    (/natural|google|samantha|aria|jenny/i.test(v.name) ? 2 : 0) +
    (v.localService ? 0 : 1);
  return voices.sort((a, b) => score(b) - score(a))[0];
}

function speak(text) {
  return new Promise((resolve) => {
    if (!canSpeak) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const voice = englishVoice();
    if (voice) u.voice = voice;
    u.rate = Number(settings.rate);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // 一部のブラウザは end イベントを発火しないことがあるので保険をかける
    const timer = setTimeout(finish, 5000 + text.length * 140);
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  speakToken++;
  if (canSpeak) speechSynthesis.cancel();
}

/** iOS は操作直後でないと読み上げを開始できないため、タップ時に一度鳴らしておく */
function unlockSpeech() {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
}

/**
 * 聞き取りを始める。終わると onDone(text, failure) を一度だけ呼ぶ。
 * prefix を渡すと、その続きとして聞き取る。
 */
function startRecognition({ lang, prefix = "", silenceMs, onInterim, onDone }) {
  stopSpeaking();
  const rec = new Recognition();
  recognition = rec;
  rec.lang = lang;
  rec.interimResults = true;
  // Android の Chrome は continuous だと結果が重複するので単発で使う
  rec.continuous = !/Android/i.test(navigator.userAgent);

  let transcript = "";
  let failure = "";
  let silence;
  const joined = () => `${prefix} ${transcript}`.replace(/\s+/g, " ").trim();
  const armSilence = (ms) => {
    clearTimeout(silence);
    silence = setTimeout(() => rec.stop(), ms);
  };

  rec.onresult = (event) => {
    transcript = Array.from(event.results, (r) => r[0].transcript).join(" ");
    onInterim(joined());
    armSilence(silenceMs);
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      failure = "マイクが許可されていません。ブラウザの設定でマイクを許可してください。";
    } else if (event.error === "network") {
      failure = "音声認識に接続できませんでした。";
    }
  };
  rec.onend = () => {
    clearTimeout(silence);
    if (recognition !== rec) return;
    recognition = null;
    onDone(joined(), failure);
  };

  try {
    rec.start();
    armSilence(12000);
  } catch {
    recognition = null;
    onDone(prefix, "マイクを開始できませんでした。");
  }
}

function stopListening(discard = false) {
  const rec = recognition;
  if (!rec) return;
  if (discard) {
    recognition = null;
    rec.abort();
  } else {
    rec.stop();
  }
}

// ---- 会話 ----------------------------------------------------------------

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.needLogin) {
    leaveSession();
    show("login");
  }
  if (!res.ok) throw new Error(data.error || "通信エラーが起きました。");
  return data;
}

function listen(lang, prefix = "") {
  if (!canListen) return;
  clearPending();
  hideHints();
  setMode("listening");
  if (prefix) setStatus(prefix, "heard");
  else setStatus(lang === "ja-JP" ? "日本語でどうぞ。英語での言い方を教えます。" : "どうぞ、話してください…");
  startRecognition({
    lang,
    prefix,
    silenceMs: SILENCE_MS[settings.level - 1] ?? 3000,
    onInterim: (text) => setStatus(text, "heard"),
    onDone: (text, failure) => {
      if (text) return confirmHeard(text, lang);
      setMode("idle");
      setStatus(failure || "聞き取れませんでした。マイクをタップしてもう一度どうぞ。", failure ? "error" : "");
    },
  });
}

/** 聞き取った文を見せ、少し待ってから送る。その間に言い直しや言い足しができる */
function confirmHeard(text, lang) {
  pending = { text, lang };
  setMode("confirm");
  setStatus(text, "heard");
  confirmTimer = setTimeout(sendPending, CONFIRM_MS);
}

function clearPending() {
  clearTimeout(confirmTimer);
  const p = pending;
  pending = null;
  return p;
}

function sendPending() {
  const p = clearPending();
  if (p) sendUserText(p.text);
}

function sendUserText(text) {
  messages.push({ role: "user", text });
  stats.turns++;
  const today = dayString();
  if (!stats.days.includes(today)) stats.days = [...stats.days, today].slice(-400);
  save("sse-stats", stats);
  renderLog();
  requestTurn();
}

async function requestTurn() {
  const session = scenario;
  retry = null;
  setMode("thinking");
  setStatus("考え中…");
  let data;
  try {
    data = await post("/api/chat", {
      level: settings.level,
      scenario: scenario.id,
      focus,
      messages: messages.map(({ role, text }) => ({ role, text })),
    });
  } catch (error) {
    if (scenario !== session) return;
    retry = requestTurn;
    setMode("idle");
    setStatus(error.message, "error");
    return;
  }
  if (scenario !== session) return;

  const last = messages.at(-1);
  if (last?.role === "user") {
    last.feedback = data.feedback;
    if (data.feedback && !data.feedback.ok && data.feedback.better) {
      addNote({ en: data.feedback.better, ja: data.feedback.note_ja, said: last.text });
    }
  }
  for (const i of data.goals_done || []) {
    if (Number.isInteger(i) && i >= 0 && i < scenario.goals.length) goalsDone.add(i);
  }
  if (goalsDone.size === scenario.goals.length) {
    stats.cleared[`${scenario.id}:${settings.level}`] = true;
    save("sse-stats", stats);
  }
  renderGoals();

  const reply = { role: "assistant", text: data.reply, ja: data.reply_ja, shown: showTextByDefault() };
  messages.push(reply);
  hints = data.hints || [];
  renderLog();
  await say(reply.text);
}

/** 相手のセリフを読み上げ、終わったら聞き取りに戻る */
async function say(text) {
  clearPending();
  stopListening(true);
  stopSpeaking();
  const token = speakToken;
  setMode("speaking");
  setStatus(canSpeak ? "相手が話しています…" : "");
  await speak(text);
  if (token !== speakToken || mode !== "speaking") return;
  if (settings.handsFree && canListen) {
    listen("en-US");
  } else {
    setMode("idle");
    setStatus(canListen ? "マイクをタップして返事しよう" : "下の入力欄から英語で返事しよう");
  }
}

/** ヒントや添削の例文を聞く(会話の進行は変えない) */
async function sayExample(text) {
  if (mode === "listening") stopListening(true);
  clearPending();
  stopSpeaking();
  if (mode !== "thinking") setMode("idle");
  await speak(text);
}

// ---- 画面 ----------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function show(screen) {
  for (const id of ["login", "home", "talk", "practice", "review"]) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function setMode(next) {
  mode = next;
  document.body.dataset.mode = next;
  const started = messages.some((m) => m.role === "assistant");
  const confirming = next === "confirm";
  $("mic").disabled = !canListen || next === "thinking" || !scenario;
  $("mic").setAttribute("aria-label", confirming ? "送信する" : next === "listening" ? "話し終える" : "話す");
  $("hint-btn").hidden = $("ja-btn").hidden = confirming;
  $("redo-btn").hidden = $("more-btn").hidden = !confirming;
  $("countdown").hidden = !confirming;
  $("ja-btn").disabled = !canListen || next !== "idle" || !started;
  $("hint-btn").disabled = next === "thinking" || !hints.length;
  $("type-form").querySelector("button").disabled = next === "thinking" || !started;
}

function setStatus(text, kind = "") {
  const status = $("status");
  status.className = `status ${kind}`;
  status.replaceChildren(text);
  if (kind === "error" && retry) {
    status.append(" ", el("button", { class: "link", type: "button", onclick: () => retry?.() }, "再試行"));
  }
}

function hideHints() {
  $("hints").hidden = true;
}

function renderHints() {
  $("hints").replaceChildren(
    el("p", { class: "hints-title" }, "こう言ってみよう"),
    ...hints.map((hint) =>
      el("button", { class: "hint", type: "button", onclick: () => sayExample(hint) }, el("span", {}, "🔊"), hint),
    ),
  );
}

function renderGoals() {
  const all = scenario && goalsDone.size === scenario.goals.length;
  $("goals").replaceChildren(
    ...(scenario?.goals || []).map((goal, i) =>
      el("li", { class: goalsDone.has(i) ? "done" : "" }, goalsDone.has(i) ? `✓ ${goal}` : goal),
    ),
    ...(all ? [el("li", { class: "clear" }, "🎉 ミッション達成!")] : []),
  );
}

function renderMessage(m) {
  if (m.role === "assistant") {
    const body = m.shown
      ? el("p", { class: "en" }, m.text)
      : el(
          "button",
          {
            class: "reveal",
            type: "button",
            onclick: () => {
              m.shown = true;
              renderLog(false);
            },
          },
          "聞き取れなかったら、タップして英文を表示",
        );
    return el(
      "div",
      { class: "msg them" },
      body,
      m.shown && m.jaShown && el("p", { class: "ja" }, m.ja),
      el(
        "div",
        { class: "msg-actions" },
        canSpeak && el("button", { class: "link", type: "button", onclick: () => say(m.text) }, "🔊 もう一度聞く"),
        m.shown &&
          !m.jaShown &&
          el(
            "button",
            {
              class: "link",
              type: "button",
              onclick: () => {
                m.jaShown = true;
                renderLog(false);
              },
            },
            "日本語訳",
          ),
      ),
    );
  }

  const f = m.feedback;
  let feedback = null;
  if (f?.ok && f.note_ja) {
    feedback = el("div", { class: "feedback good" }, el("p", {}, `✓ ${f.note_ja}`));
  } else if (f && !f.ok && f.better) {
    feedback = el(
      "div",
      { class: "feedback fix" },
      el("p", { class: "better" }, f.better),
      f.note_ja && el("p", {}, f.note_ja),
      canSpeak &&
        el("button", { class: "link", type: "button", onclick: () => sayExample(f.better) }, "🔊 お手本を聞く"),
    );
  }
  return el("div", { class: "msg me" }, el("p", { class: "en" }, m.text), feedback);
}

function renderLog(scroll = true) {
  const log = $("log");
  log.replaceChildren(...messages.map(renderMessage));
  if (scroll) log.lastElementChild?.scrollIntoView({ block: "end" });
}

function streak() {
  const days = new Set(stats.days);
  // 今日まだ練習していなくても、昨日までの連続は途切れていない
  let offset = days.has(dayString()) ? 0 : -1;
  let count = 0;
  while (days.has(dayString(offset))) {
    count++;
    offset--;
  }
  return count;
}

function levelName(id) {
  return config.levels.find((l) => l.id === id)?.name ?? `Step ${id}`;
}

function renderHome() {
  const cleared = (s) => Boolean(stats.cleared[`${s.id}:${settings.level}`]);

  $("levels").replaceChildren(
    ...config.levels.map((level) =>
      el(
        "button",
        {
          class: "level",
          type: "button",
          role: "radio",
          "aria-checked": String(level.id === settings.level),
          onclick: () => {
            settings.level = level.id;
            save("sse-settings", settings);
            renderHome();
          },
        },
        el("strong", {}, level.name),
        el("span", {}, level.label),
        el("small", {}, level.desc),
      ),
    ),
  );

  $("scenarios").replaceChildren(
    ...config.scenarios.map((s) =>
      el(
        "button",
        { class: "scenario", type: "button", onclick: () => startSession(s) },
        el("span", { class: "emoji", "aria-hidden": "true" }, s.emoji),
        el("span", {}, el("strong", {}, s.title), el("small", {}, s.desc)),
        cleared(s) && el("span", { class: "badge" }, "✓ 達成"),
      ),
    ),
  );

  const done = config.scenarios.filter(cleared).length;
  const total = config.scenarios.length;
  const next = config.levels.find((l) => l.id === settings.level + 1);
  $("level-progress").textContent =
    done === total && total > 0
      ? next
        ? `全シーン達成!${next.name} に挑戦しよう`
        : "全シーン達成!"
      : `${levelName(settings.level)} のミッション達成 ${done}/${total}`;

  const due = dueNotes().length;
  $("practice-entry").hidden = !notebook.length;
  $("practice-entry").replaceChildren(
    due
      ? el(
          "button",
          { class: "entry", type: "button", onclick: startPractice },
          el("span", { class: "emoji", "aria-hidden": "true" }, "📒"),
          el("span", {}, el("strong", {}, `今日の復習 ${due} 個`), el("small", {}, "前に直された表現を、声に出してもう一度")),
        )
      : el(
          "div",
          { class: "entry rest" },
          el("span", { class: "emoji", "aria-hidden": "true" }, "📒"),
          el("span", {}, `今日の復習はありません(保存した表現 ${notebook.length} 個)`),
        ),
  );

  $("stats").hidden = !stats.turns;
  $("stats").textContent = `これまでに ${stats.turns} 回発話 ・ ${stats.sessions} セッション ・ ${streak()} 日連続`;

  const notes = [];
  if (!canListen) notes.push("このブラウザは音声認識に対応していません。Chrome・Edge・Safari を使うと声で会話できます(今は文字入力で練習できます)。");
  if (!canSpeak) notes.push("このブラウザは読み上げに対応していないため、相手のセリフは文字で表示されます。");
  $("support-note").hidden = !notes.length;
  $("support-note").textContent = notes.join(" ");
}

function startSession(s) {
  unlockSpeech();
  scenario = s;
  messages = [];
  hints = [];
  goalsDone = new Set();
  // 復習中の表現を会話の中でも使えるよう、相手役に伝えておく
  focus = [...notebook]
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 3)
    .map((n) => n.en);
  $("talk-title").textContent = `${s.emoji} ${s.title} ・ ${levelName(settings.level)}`;
  $("opt-text").checked = showTextByDefault();
  $("opt-hands").checked = settings.handsFree;
  $("opt-rate").value = String(settings.rate);
  $("opt-hands").closest("label").hidden = !canListen;
  hideHints();
  renderGoals();
  renderLog();
  show("talk");
  requestTurn();
}

function leaveSession() {
  clearPending();
  stopListening(true);
  stopSpeaking();
  scenario = null;
  retry = null;
  setMode("idle");
}

async function endSession() {
  const transcript = messages.map(({ role, text }) => ({ role, text }));
  const level = settings.level;
  leaveSession();
  if (!transcript.some((m) => m.role === "user")) {
    renderHome();
    show("home");
    return;
  }
  stats.sessions++;
  save("sse-stats", stats);

  const body = $("review-body");
  show("review");
  const run = async () => {
    body.replaceChildren(el("p", { class: "loading" }, "会話をふりかえっています…"));
    try {
      renderReview(await post("/api/review", { level, messages: transcript }), level);
    } catch (error) {
      body.replaceChildren(
        el("p", { class: "status error" }, error.message),
        el("button", { class: "link", type: "button", onclick: run }, "再試行"),
      );
    }
  };
  run();
}

function renderReview(r, level) {
  for (const i of r.improvements) addNote({ en: i.better, ja: i.note_ja, said: i.said });
  for (const p of r.phrases) addNote({ en: p.en, ja: p.ja });

  const step = r.level_advice === "up" ? 1 : r.level_advice === "down" ? -1 : 0;
  const target = config.levels.find((l) => l.id === level + step && step !== 0);
  const levelCard = el(
    "section",
    { class: "card" },
    el("h2", {}, "次のレベル"),
    el("p", {}, r.level_reason_ja),
    target &&
      el(
        "button",
        {
          class: "primary",
          type: "button",
          onclick: (event) => {
            settings.level = target.id;
            save("sse-settings", settings);
            event.currentTarget.disabled = true;
            event.currentTarget.textContent = `次回から ${target.name}(${target.label})で始めます`;
          },
        },
        `${target.name}(${target.label})に${step > 0 ? "上げる" : "下げる"}`,
      ),
  );

  const list = (items) => el("ul", {}, ...items.map((item) => el("li", {}, item)));
  const sections = [
    el("section", { class: "card" }, el("p", {}, r.summary_ja)),
    el("section", { class: "card" }, el("h2", {}, "よかったところ"), list(r.strengths_ja)),
    r.improvements.length > 0 &&
      el(
        "section",
        { class: "card" },
        el("h2", {}, "こう言うともっと自然"),
        ...r.improvements.map((i) =>
          el(
            "div",
            { class: "fix-item" },
            el("p", { class: "said" }, i.said),
            el(
              "p",
              { class: "better" },
              i.better,
              canSpeak && el("button", { class: "link", type: "button", onclick: () => speak(i.better) }, "🔊"),
            ),
            el("p", { class: "ja" }, i.note_ja),
          ),
        ),
      ),
    el(
      "section",
      { class: "card" },
      el("h2", {}, "次に使ってみたいフレーズ"),
      ...r.phrases.map((p) =>
        el(
          "p",
          { class: "phrase" },
          canSpeak && el("button", { class: "link", type: "button", onclick: () => speak(p.en) }, "🔊"),
          el("strong", {}, p.en),
          el("span", { class: "ja" }, p.ja),
        ),
      ),
      el("p", { class: "tip" }, "直した表現とフレーズは復習リストに保存しました。明日からホームの「今日の復習」に出ます。"),
    ),
    el("section", { class: "card" }, el("h2", {}, "次回のポイント"), el("p", {}, r.next_step_ja)),
    levelCard,
  ];
  $("review-body").replaceChildren(...sections.filter(Boolean));
}

// ---- 復習 ----------------------------------------------------------------

function startPractice() {
  unlockSpeech();
  practice = { queue: dueNotes().slice(0, 10), retried: new Set() };
  show("practice");
  nextCard();
}

function nextCard() {
  practice.heard = "";
  practice.match = false;
  practice.revealed = false;
  practice.message = "";
  renderCard();
}

/** 目標の文の単語がどれだけ言えているかで判定する(認識の揺れを許容するため完全一致は求めない) */
function saidIt(heard, target) {
  const said = new Set(normalize(heard).split(" "));
  const words = normalize(target).split(" ");
  return words.filter((w) => said.has(w)).length / words.length >= 0.8;
}

function reveal() {
  practice.revealed = true;
  renderCard();
  speak(practice.queue[0].en);
}

function grade(ok) {
  const item = practice.queue.shift();
  if (ok) {
    item.box = Math.min((item.box || 0) + 1, INTERVALS.length);
    item.due = dayString(INTERVALS[item.box - 1]);
  } else {
    item.box = 0;
    item.due = dayString();
    // 言えなかった表現は、この回の最後にもう一度だけ出す
    if (!practice.retried.has(item)) {
      practice.retried.add(item);
      practice.queue.push(item);
    }
  }
  save("sse-notebook", notebook);
  nextCard();
}

function practiceListen() {
  if (mode === "listening") return stopListening();
  practice.message = "どうぞ、話してください…";
  setMode("listening");
  renderCard();
  startRecognition({
    lang: "en-US",
    silenceMs: 3000,
    onInterim: (text) => {
      practice.message = text;
      renderCard();
    },
    onDone: (text, failure) => {
      setMode("idle");
      if (!practice) return;
      if (!text) {
        practice.message = failure || "聞き取れませんでした。もう一度どうぞ。";
        return renderCard();
      }
      practice.message = "";
      practice.heard = text;
      practice.match = saidIt(text, practice.queue[0].en);
      reveal();
    },
  });
}

function renderCard() {
  const body = $("practice-body");
  const item = practice.queue[0];
  $("practice-title").textContent = item ? `復習 ・ 残り ${practice.queue.length}` : "復習";
  if (!item) {
    body.replaceChildren(
      el("section", { class: "card center" }, el("p", { class: "prompt" }, "🎉 今日の復習はおわり!"), el("p", { class: "ja" }, "言えた表現は、日をあけてまた出てきます。")),
      el("button", { class: "primary", type: "button", onclick: leavePractice }, "ホームに戻る"),
    );
    return;
  }

  const card = el(
    "section",
    { class: "card" },
    el("p", { class: "prompt-label" }, item.said ? "前にこう言いました。もっと自然に言うと?" : "英語で言ってみよう"),
    el("p", { class: "prompt" }, item.said || item.ja),
    practice.heard && el("p", { class: "ja" }, `あなた: ${practice.heard}`),
    practice.revealed &&
      el(
        "div",
        { class: "answer" },
        el("p", { class: "en" }, item.en),
        item.ja && el("p", { class: "ja" }, item.ja),
        canSpeak && el("button", { class: "link", type: "button", onclick: () => speak(item.en) }, "🔊 お手本を聞く"),
        practice.heard &&
          el(
            "p",
            { class: `verdict ${practice.match ? "good" : "near"}` },
            practice.match ? "✓ 言えました!" : "お手本と少し違うようです。聞いて、もう一度声に出してみよう。",
          ),
      ),
  );

  const controls = el(
    "div",
    { class: "practice-controls" },
    el("p", { class: "status heard" }, practice.message),
    canListen &&
      el(
        "button",
        { class: "mic", type: "button", "aria-label": mode === "listening" ? "話し終える" : "話す", onclick: practiceListen },
        $("mic").querySelector("svg").cloneNode(true),
      ),
    practice.revealed
      ? el(
          "div",
          { class: "grade" },
          el("button", { type: "button", onclick: () => grade(false) }, "まだ"),
          el("button", { class: "yes", type: "button", onclick: () => grade(true) }, "言えた"),
        )
      : el("button", { class: "link", type: "button", onclick: reveal }, "答えを見る"),
  );

  body.replaceChildren(card, controls);
}

function leavePractice() {
  stopListening(true);
  stopSpeaking();
  practice = null;
  setMode("idle");
  renderHome();
  show("home");
}

// ---- イベント ------------------------------------------------------------

$("mic").addEventListener("click", () => {
  if (mode === "listening") stopListening();
  else if (mode === "confirm") sendPending();
  else if (mode !== "thinking") listen("en-US");
});

$("ja-btn").addEventListener("click", () => listen("ja-JP"));

$("redo-btn").addEventListener("click", () => {
  const p = clearPending();
  if (p) listen(p.lang);
});

$("more-btn").addEventListener("click", () => {
  const p = clearPending();
  if (p) listen(p.lang, p.text);
});

$("hint-btn").addEventListener("click", () => {
  if ($("hints").hidden) renderHints();
  $("hints").hidden = !$("hints").hidden;
});

$("type-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("type-input");
  const text = input.value.trim();
  if (!text || mode === "thinking") return;
  input.value = "";
  clearPending();
  stopListening(true);
  stopSpeaking();
  hideHints();
  sendUserText(text);
});

$("end").addEventListener("click", endSession);
$("practice-end").addEventListener("click", leavePractice);

$("review-home").addEventListener("click", () => {
  stopSpeaking();
  renderHome();
  show("home");
});

$("settings-toggle").addEventListener("click", () => {
  const panel = $("settings");
  panel.hidden = !panel.hidden;
  $("settings-toggle").setAttribute("aria-expanded", String(!panel.hidden));
});

$("opt-text").addEventListener("change", (e) => {
  settings.showText = e.target.checked;
  save("sse-settings", settings);
});
$("opt-hands").addEventListener("change", (e) => {
  settings.handsFree = e.target.checked;
  save("sse-settings", settings);
});
$("opt-rate").addEventListener("change", (e) => {
  settings.rate = Number(e.target.value);
  save("sse-settings", settings);
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await post("/api/login", { password: $("login-input").value });
    $("login-input").value = "";
    await init();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

// 音声一覧は非同期に読み込まれるので、先に取得を促しておく
if (canSpeak) speechSynthesis.getVoices();

async function init() {
  try {
    const res = await fetch("/api/config");
    config = await res.json();
    if (!config.levels.some((l) => l.id === settings.level)) settings.level = 2;
    renderHome();
    show(config.needLogin ? "login" : "home");
  } catch {
    show("home");
    $("support-note").hidden = false;
    $("support-note").textContent = "サーバーに接続できませんでした。ページを再読み込みしてください。";
  }
}

init();

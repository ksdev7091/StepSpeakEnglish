const $ = (id) => document.getElementById(id);

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canListen = Boolean(Recognition);
const canSpeak = "speechSynthesis" in window;

// ---- 保存データ ----------------------------------------------------------

function load(key, fallback) {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key)) };
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // プライベートブラウズなどで保存できなくても動作は続ける
  }
}

const settings = load("sse-settings", { level: 2, showText: !canSpeak, handsFree: false, rate: 0.85 });
const stats = load("sse-stats", { turns: 0, sessions: 0, days: [] });

// ---- 状態 ----------------------------------------------------------------

let config = { levels: [], scenarios: [] };
let scenario = null;
let messages = []; // { role, text, ja?, feedback?, shown?, jaShown? }
let hints = [];
let mode = "idle"; // idle | listening | thinking | speaking
let recognition = null;
let speakToken = 0;
let retry = null;

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

function listen(lang) {
  if (!canListen) return;
  stopSpeaking();
  hideHints();
  const rec = new Recognition();
  recognition = rec;
  rec.lang = lang;
  rec.interimResults = true;
  // Android の Chrome は continuous だと結果が重複するので単発で使う
  rec.continuous = !/Android/i.test(navigator.userAgent);

  let transcript = "";
  let failure = "";
  let silence;
  const armSilence = (ms) => {
    clearTimeout(silence);
    silence = setTimeout(() => rec.stop(), ms);
  };

  rec.onresult = (event) => {
    transcript = Array.from(event.results, (r) => r[0].transcript).join(" ");
    setStatus(transcript, "heard");
    armSilence(2200);
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
    const text = transcript.replace(/\s+/g, " ").trim();
    if (text) {
      sendUserText(text);
    } else {
      setMode("idle");
      setStatus(failure || "聞き取れませんでした。マイクをタップしてもう一度どうぞ。", failure ? "error" : "");
    }
  };

  setMode("listening");
  setStatus(lang === "ja-JP" ? "日本語でどうぞ。英語での言い方を教えます。" : "どうぞ、話してください…");
  try {
    rec.start();
    armSilence(10000);
  } catch {
    recognition = null;
    setMode("idle");
    setStatus("マイクを開始できませんでした。", "error");
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
  if (!res.ok) throw new Error(data.error || "通信エラーが起きました。");
  return data;
}

function sendUserText(text) {
  messages.push({ role: "user", text });
  stats.turns++;
  const today = new Date().toLocaleDateString("sv");
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
  if (last?.role === "user") last.feedback = data.feedback;
  const reply = { role: "assistant", text: data.reply, ja: data.reply_ja, shown: settings.showText || !canSpeak };
  messages.push(reply);
  hints = data.hints || [];
  renderLog();
  await say(reply.text);
}

/** 相手のセリフを読み上げ、終わったら聞き取りに戻る */
async function say(text) {
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
  for (const id of ["home", "talk", "review"]) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function setMode(next) {
  mode = next;
  document.body.dataset.mode = next;
  const started = messages.some((m) => m.role === "assistant");
  $("mic").disabled = !canListen || next === "thinking" || !scenario;
  $("mic").setAttribute("aria-label", next === "listening" ? "話し終える" : "話す");
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
  const day = new Date();
  // 今日まだ練習していなくても、昨日までの連続は途切れていない
  if (!days.has(day.toLocaleDateString("sv"))) day.setDate(day.getDate() - 1);
  let count = 0;
  while (days.has(day.toLocaleDateString("sv"))) {
    count++;
    day.setDate(day.getDate() - 1);
  }
  return count;
}

function renderHome() {
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
      ),
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
  const level = config.levels.find((l) => l.id === settings.level);
  $("talk-title").textContent = `${s.emoji} ${s.title} ・ ${level.name}`;
  $("opt-text").checked = settings.showText;
  $("opt-hands").checked = settings.handsFree;
  $("opt-rate").value = String(settings.rate);
  $("opt-hands").closest("label").hidden = !canListen;
  hideHints();
  renderLog();
  show("talk");
  requestTurn();
}

function leaveSession() {
  stopListening(true);
  stopSpeaking();
  scenario = null;
  retry = null;
  setMode("idle");
}

async function endSession() {
  const transcript = messages.map(({ role, text }) => ({ role, text }));
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
      renderReview(await post("/api/review", { messages: transcript }));
    } catch (error) {
      body.replaceChildren(
        el("p", { class: "status error" }, error.message),
        el("button", { class: "link", type: "button", onclick: run }, "再試行"),
      );
    }
  };
  run();
}

function renderReview(r) {
  const list = (items) => el("ul", {}, ...items.map((item) => el("li", {}, item)));
  $("review-body").replaceChildren(
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
    ),
    el("section", { class: "card" }, el("h2", {}, "次回のポイント"), el("p", {}, r.next_step_ja)),
  );
}

// ---- イベント ------------------------------------------------------------

$("mic").addEventListener("click", () => {
  if (mode === "listening") stopListening();
  else if (mode !== "thinking") listen("en-US");
});

$("ja-btn").addEventListener("click", () => listen("ja-JP"));

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
  stopListening(true);
  stopSpeaking();
  hideHints();
  sendUserText(text);
});

$("end").addEventListener("click", endSession);

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

// 音声一覧は非同期に読み込まれるので、先に取得を促しておく
if (canSpeak) speechSynthesis.getVoices();

try {
  const res = await fetch("/api/config");
  config = await res.json();
  if (!config.levels.some((l) => l.id === settings.level)) settings.level = 2;
  renderHome();
} catch {
  $("support-note").hidden = false;
  $("support-note").textContent = "サーバーに接続できませんでした。ページを再読み込みしてください。";
}

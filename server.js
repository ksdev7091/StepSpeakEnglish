import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// 会話はテンポが大事なので、深く考えさせず短く返させる
const EFFORT = "low";
// モデルに渡す会話履歴の上限。超えた分は古いものから省く
const MAX_TURNS = 60;
const MAX_TEXT = 600;

// 公開時の合言葉。設定すると、合言葉を知っている人だけが会話できる
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_COOKIE = "sse_auth";
const AUTH_TOKEN = APP_PASSWORD
  ? crypto.createHmac("sha256", APP_PASSWORD).update("stepspeak-auth-v1").digest("hex")
  : "";

const client = new Anthropic();

const LEVELS = [
  {
    id: 1,
    name: "Step 1",
    label: "入門",
    desc: "かんたんな単語と短い文",
    guide:
      "Absolute beginner. Use only very common words and short sentences of about 8 words or fewer. Ask one simple question at a time, preferably one that can be answered in a few words.",
  },
  {
    id: 2,
    name: "Step 2",
    label: "初級",
    desc: "中学英語でゆっくり会話",
    guide:
      "Beginner. Use simple everyday vocabulary and short, clear sentences. Avoid idioms and phrasal verbs that are not very common.",
  },
  {
    id: 3,
    name: "Step 3",
    label: "中級",
    desc: "日常会話をふつうの表現で",
    guide:
      "Intermediate. Speak naturally about everyday topics with ordinary vocabulary. Common idioms are fine. Ask questions that invite a sentence or two.",
  },
  {
    id: 4,
    name: "Step 4",
    label: "中上級",
    desc: "意見や理由を伝える",
    guide:
      "Upper intermediate. Speak as you would to a fluent friend, and ask for opinions, reasons and comparisons so the learner has to build longer answers.",
  },
  {
    id: 5,
    name: "Step 5",
    label: "上級",
    desc: "ネイティブと同じ速さ・語彙",
    guide:
      "Advanced. Speak exactly as you would to another native speaker, including idioms and nuance. Push back on ideas and ask follow-up questions that need precise, nuanced answers.",
  },
];

const SCENARIOS = [
  {
    id: "free",
    goals: ["今日したことを話す", "好きなものとその理由を話す", "相手に質問を1つする"],
    emoji: "💬",
    title: "フリートーク",
    desc: "今日あったことや趣味を気軽に",
    role: "You are Emma, a friendly conversation partner. Chat casually about the learner's day, hobbies, food, plans and whatever they bring up.",
  },
  {
    id: "intro",
    goals: ["名前と出身を伝える", "仕事や学校について話す", "相手に質問を1つする"],
    emoji: "👋",
    title: "自己紹介",
    desc: "はじめて会う人との会話",
    role: "You are Emma. You and the learner are meeting for the first time at a casual international meetup. Get to know each other: names, where you are from, work, hobbies.",
  },
  {
    id: "cafe",
    goals: ["飲み物を注文する", "サイズを伝える", "店内か持ち帰りかを伝える"],
    emoji: "☕",
    title: "カフェで注文",
    desc: "店員さんとのやりとり",
    role: "You are a barista at a coffee shop and the learner is a customer. Take their order: drink, size, hot or iced, food, for here or to go, payment.",
  },
  {
    id: "restaurant",
    goals: ["人数を伝えて席に着く", "料理と飲み物を注文する", "お会計を頼む"],
    emoji: "🍽️",
    title: "レストラン",
    desc: "入店から会計まで",
    role: "You are a server at a casual restaurant and the learner is a guest. Go from greeting and seating through ordering, checking on the meal, and the check.",
  },
  {
    id: "travel",
    goals: ["チェックインして名前を伝える", "朝食やWi-Fiなど設備について質問する", "行きたい場所への行き方をたずねる"],
    emoji: "✈️",
    title: "海外旅行",
    desc: "空港・ホテル・道案内",
    role: "The learner is travelling abroad. Play the people they meet, starting as a hotel front-desk clerk at check-in, and later move to other travel situations such as asking for directions or airport check-in.",
  },
  {
    id: "shopping",
    goals: ["探している物を伝える", "サイズか色について相談する", "買うかどうかを伝える"],
    emoji: "🛍️",
    title: "ショッピング",
    desc: "服のサイズや色を相談",
    role: "You are a shop assistant in a clothing store and the learner is a customer. Help with sizes, colours, trying things on, prices and paying.",
  },
  {
    id: "work",
    goals: ["仕事の進み具合を伝える", "予定や締め切りについて話す", "自分の意見を理由つきで言う"],
    emoji: "💼",
    title: "仕事の会話",
    desc: "同僚との雑談とミーティング",
    role: "You are Alex, the learner's colleague at an international company. Mix small talk with work talk: how projects are going, schedules, and asking for their opinion in a short meeting.",
  },
  {
    id: "interview",
    goals: ["自己紹介をする", "自分の強みを話す", "面接官に質問を1つする"],
    emoji: "🎤",
    title: "英語面接",
    desc: "よく聞かれる質問に答える",
    role: "You are an interviewer and the learner is a job candidate. Ask common interview questions one at a time and follow up on their answers.",
  },
];

function systemPrompt(level, scenario, focus) {
  const goals = scenario.goals.map((g, i) => `${i}: ${g}`).join("\n");
  const focusNote = focus.length
    ? `

The learner is reviewing these expressions from earlier sessions:
${focus.map((f) => `- ${f}`).join("\n")}
Where it fits the scenario naturally, steer the conversation so they get a chance to use one. Do not say the expressions yourself first, and do not force them in where they do not belong.`
    : "";
  return `You are an English conversation partner for a native Japanese speaker who wants to become able to speak English. The whole conversation happens by voice: each learner message is a speech-recognition transcript, and your "reply" is read aloud by text-to-speech. The app shows the other fields on screen as study aids.

Scenario: ${scenario.role}

Learner level: ${level.guide}

Mission goals for the learner in this scene (the app shows them as a checklist):
${goals}
Guide the conversation so each goal gets a natural opening, without announcing the goals.${focusNote}

reply — what you say aloud, in character.
- Plain spoken English only: no markdown, emoji, lists or stage directions, because every character is spoken.
- Keep it to one to three sentences, then hand the turn back with a question or prompt. The learner improves by talking, so they should be speaking more than you.
- React to what they actually said like a real person would, rather than moving through a script.
- Do not correct the learner inside the reply; corrections go in "feedback" so the conversation keeps flowing.

Transcripts have no reliable punctuation or capitalisation and sometimes contain recognition mistakes. Never treat those as learner errors. If a word looks like a mis-hearing of something sensible, assume the sensible reading. If you truly cannot tell what they meant, ask them to say it again.

If the learner speaks Japanese, they are stuck: put the English they were looking for in feedback.better, and answer in simple English as if they had said that.

reply_ja — a natural Japanese translation of reply.

feedback — about the learner's most recent utterance only.
- ok: true when it was natural enough that a native speaker would not blink; false when there is a grammar or word-choice error, or a clearly more natural way to say it.
- better: when ok is false, the corrected or more natural English sentence. Empty string when ok is true.
- note_ja: one or two short Japanese sentences. When ok is false, explain why "better" is better. When ok is true, say something specific about what worked. For the opening turn, where the learner has not spoken yet, use an empty string.

hints — exactly two short things the learner could say next, at their level, written in English. They are shown only when the learner asks for help.

goals_done — the numbers of every mission goal the learner has achieved so far in this conversation through what they themselves said in English, however imperfectly. Cumulative: keep listing goals achieved in earlier turns.`;
}

const TurnSchema = z.object({
  reply: z.string(),
  reply_ja: z.string(),
  feedback: z.object({
    ok: z.boolean(),
    better: z.string(),
    note_ja: z.string(),
  }),
  hints: z.array(z.string()),
  goals_done: z.array(z.number()),
});

const ReviewSchema = z.object({
  summary_ja: z.string(),
  strengths_ja: z.array(z.string()),
  improvements: z.array(
    z.object({ said: z.string(), better: z.string(), note_ja: z.string() }),
  ),
  phrases: z.array(z.object({ en: z.string(), ja: z.string() })),
  next_step_ja: z.string(),
  level_advice: z.enum(["up", "stay", "down"]),
  level_reason_ja: z.string(),
});

const REVIEW_PROMPT = `You are an English speaking coach for a native Japanese speaker. Below is the transcript of a spoken practice conversation. Learner lines are speech-recognition transcripts, so ignore punctuation, capitalisation and obvious recognition mistakes.

Write a short review of the learner's speaking, in Japanese except where English examples are needed:
- summary_ja: two or three sentences on how the session went overall.
- strengths_ja: two or three specific things the learner did well, quoting what they said where you can.
- improvements: up to four of the most useful corrections. "said" is what the learner said, "better" is the natural English, "note_ja" is a one-sentence explanation. Pick recurring or high-impact patterns over one-off slips. Use an empty array if there is nothing worth correcting.
- phrases: three to five useful English phrases from this conversation's situation that the learner should try next time, each with a Japanese meaning.
- next_step_ja: one concrete thing to focus on in the next session.
- level_advice: whether the learner should change difficulty next time. "up" when they kept up comfortably, answered in full sentences and made few errors; "down" when they struggled to answer most turns or mostly fell back on Japanese or single words; otherwise "stay". With fewer than about five learner turns there is too little evidence, so answer "stay".
- level_reason_ja: one sentence explaining that advice.`;

/** クライアントから届いた会話履歴を検証して整える */
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-MAX_TURNS)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.text !== "string") return null;
    const text = m.text.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    out.push({ role: m.role, text });
  }
  return out;
}

async function ask({ system, messages, schema }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages,
    output_config: { effort: EFFORT, format: zodOutputFormat(schema) },
    // 安全フィルタで断られた場合に、サーバー側で別モデルへ自動的に切り替える
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "この内容には応答できませんでした。別の話題で試してください。");
  }
  if (!response.parsed_output) {
    throw new HttpError(502, "AIの応答を読み取れませんでした。もう一度試してください。");
  }
  return response.parsed_output;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, "APIキーが正しくありません。サーバーの ANTHROPIC_API_KEY を確認してください。");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new HttpError(429, "アクセスが集中しています。少し待ってからもう一度試してください。");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, "AIに接続できませんでした。通信状況を確認してください。");
  }
  if (error instanceof Anthropic.APIError) {
    console.error(`Claude API error ${error.status}: ${error.message}`);
    return new HttpError(502, "AIの応答でエラーが起きました。もう一度試してください。");
  }
  // SDKは認証情報が見つからないとリクエスト前に通常のErrorを投げる
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return new HttpError(500, "APIキーが設定されていません。サーバーに ANTHROPIC_API_KEY を設定してください。");
  }
  console.error(error);
  return new HttpError(500, "サーバーでエラーが起きました。");
}

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const cookies = (req.headers.cookie || "").split(";").map((c) => c.trim().split("="));
  const token = cookies.find(([name]) => name === AUTH_COOKIE)?.[1] || "";
  return safeEqual(token, AUTH_TOKEN);
}

/** IPごとの簡易レート制限(メモリ内。サーバー1台での利用を想定) */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.reset <= now) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}

const app = express();
// Render などのホスティングはプロキシ越しに届くので、本来のIPとHTTPSを認識させる
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(here, "public")));

app.get("/healthz", (_req, res) => res.send("ok"));

app.post(
  "/api/login",
  rateLimit({ windowMs: 15 * 60_000, max: 10, message: "試行回数が多すぎます。しばらく待ってからもう一度試してください。" }),
  (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!APP_PASSWORD || !safeEqual(password, APP_PASSWORD)) {
      return res.status(401).json({ error: "合言葉が違います。" });
    }
    res.cookie(AUTH_COOKIE, AUTH_TOKEN, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  },
);

const guard = [
  (req, res, next) => {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: "合言葉を入力してください。", needLogin: true });
  },
  rateLimit({ windowMs: 60_000, max: 30, message: "リクエストが多すぎます。少し待ってからもう一度試してください。" }),
];

app.get("/api/config", (req, res) => {
  res.json({
    needLogin: !isAuthed(req),
    levels: LEVELS.map(({ id, name, label, desc }) => ({ id, name, label, desc })),
    scenarios: SCENARIOS.map(({ id, emoji, title, desc, goals }) => ({ id, emoji, title, desc, goals })),
  });
});

app.post("/api/chat", guard, async (req, res) => {
  try {
    const level = LEVELS.find((l) => l.id === req.body?.level);
    const scenario = SCENARIOS.find((s) => s.id === req.body?.scenario);
    const history = cleanHistory(req.body?.messages);
    if (!level || !scenario || !history) throw new HttpError(400, "リクエストが正しくありません。");
    if (history.length && history.at(-1).role !== "user") {
      throw new HttpError(400, "リクエストが正しくありません。");
    }

    const focus = Array.isArray(req.body?.focus)
      ? req.body.focus
          .filter((f) => typeof f === "string" && f.trim())
          .slice(0, 3)
          .map((f) => f.trim().slice(0, 160))
      : [];

    // APIは最初がuserである必要があるので、AIから話し始めるための合図を先頭に置く
    const trimmed = req.body.messages.length > history.length;
    const opener = trimmed
      ? "(The earlier part of this conversation has been omitted. Continue from here.)"
      : "(The learner has just arrived. Start the conversation.)";
    const messages = [
      { role: "user", content: opener },
      ...history.map((m) => ({ role: m.role, content: m.text })),
    ];
    if (history[0]?.role === "user") {
      messages.splice(1, 0, { role: "assistant", content: "(Go ahead.)" });
    }

    res.json(await ask({ system: systemPrompt(level, scenario, focus), messages, schema: TurnSchema }));
  } catch (error) {
    const e = toHttpError(error);
    res.status(e.status).json({ error: e.message });
  }
});

app.post("/api/review", guard, async (req, res) => {
  try {
    const history = cleanHistory(req.body?.messages);
    if (!history || !history.some((m) => m.role === "user")) {
      throw new HttpError(400, "ふりかえる会話がありません。");
    }
    const level = LEVELS.find((l) => l.id === req.body?.level);
    const transcript =
      (level ? `The partner was speaking at this difficulty: ${level.guide}\n\n` : "") +
      history.map((m) => `${m.role === "user" ? "Learner" : "Partner"}: ${m.text}`).join("\n");
    res.json(
      await ask({
        system: REVIEW_PROMPT,
        messages: [{ role: "user", content: transcript }],
        schema: ReviewSchema,
      }),
    );
  } catch (error) {
    const e = toHttpError(error);
    res.status(e.status).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`StepSpeak English: http://localhost:${PORT}`);
  if (!APP_PASSWORD && process.env.NODE_ENV === "production") {
    console.warn("警告: APP_PASSWORD が未設定です。URLを知っている人は誰でもこのAPIキーで会話できます。");
  }
});

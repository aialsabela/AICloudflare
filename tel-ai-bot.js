
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// 📋 لیست مدل‌های قابل انتخاب — دقیقاً همان مدل‌هایی که در تستر مرورگر شما تأیید شده کار می‌کنند
const MODELS = {
  llama33:  { label: "🦙 Llama 3.3 70B",            id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", type: "chat" },
  qwen:     { label: "🐉 Qwen3.8 27B",               id: "@cf/qwen/qwen3.8-27b", type: "chat" },
  glm:      { label: "✨ GLM-4.7 Flash",             id: "@cf/zai-org/glm-4.7-flash", type: "chat" },
  gemma4:   { label: "💎 Gemma 4 26B",               id: "@cf/google/gemma-4-26b-a4b-it", type: "chat" },
  gptoss:   { label: "🧠 GPT-OSS 120B",              id: "@cf/openai/gpt-oss-120b", type: "chat" },
  image:    { label: "🎨 ساخت تصویر (FLUX)",         id: "@cf/black-forest-labs/flux-1-schnell", type: "image" }
};
const DEFAULT_MODEL_KEY = "llama33";
// مدل متنی که همیشه برای ترجمهٔ پرامپت فارسی به انگلیسی (قبل از ساخت تصویر) استفاده می‌شود
const TRANSLATE_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_HISTORY = 6;

// تابع ارسال درخواست به تلگرام (برای هر متد: sendMessage, answerCallbackQuery, editMessageText و ...)
async function sendTelegram(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
__name(sendTelegram, "sendTelegram");

// بررسی اینکه آیا کاربر در لیست سفید مجاز (ALLOWED_USER_IDS) هست یا نه.
// اگر این متغیر محیطی اصلاً تنظیم نشده باشد، ربات برای همه باز می‌ماند (سازگاری با نسخه قبلی).
function isAuthorized(env, userId) {
  if (!env.ALLOWED_USER_IDS) return true;
  const allowed = env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(String(userId));
}
__name(isAuthorized, "isAuthorized");

// اسکیپ کاراکترهای خاص HTML (ضروری برای parse_mode: "HTML" در تلگرام)
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeHtml, "escapeHtml");

// تبدیل متن (فارسی + مارک‌داون سبک مدل‌ها) به HTML امن تلگرام
// بلاک‌های ```کد``` و اینلاین `کد` تبدیل به <pre>/<code> می‌شن تا با یک لمس قابل کپی باشن
function formatForTelegram(rawText) {
  const text = String(rawText);
  const blockParts = text.split(/```([\s\S]*?)```/g);
  let html = "";
  for (let i = 0; i < blockParts.length; i++) {
    if (i % 2 === 1) {
      // این بخش یک بلاک کد است؛ اگر خط اول فقط اسم زبان باشد حذفش می‌کنیم
      const code = blockParts[i].replace(/^[ \t]*[a-zA-Z0-9_+-]*\n/, "");
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    } else {
      // داخل این بخش، تک‌بک‌تیک‌ها (اینلاین کد) را هم پردازش می‌کنیم
      const inlineParts = blockParts[i].split(/`([^`\n]+)`/g);
      for (let j = 0; j < inlineParts.length; j++) {
        html += j % 2 === 1 ? `<code>${escapeHtml(inlineParts[j])}</code>` : escapeHtml(inlineParts[j]);
      }
    }
  }
  return html;
}
__name(formatForTelegram, "formatForTelegram");

// جدا کردن بلاک‌های کد (```...```) از بقیه‌ی متن؛ هر تکه جداگانه و امن ارسال می‌شود
function splitCodeBlocks(text) {
  const regex = /```(\w+)?\n?([\s\S]*?)```/g;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", lang: match[1] || "", content: match[2] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}
__name(splitCodeBlocks, "splitCodeBlocks");

// ارسال «هوشمند» پاسخ مدل به تلگرام: بلاک‌های کد از بقیه‌ی متن جدا می‌شوند، هر بخش به «تکه‌»های
// امن HTML تبدیل می‌شود، و سپس این تکه‌ها تا سقف تلگرام (۴۰۹۶ کاراکتر) در کمترین تعداد پیام
// ممکن با هم ادغام می‌شوند — یعنی فقط وقتی پیام واقعاً طولانی باشد چند تکه می‌شود، نه هر بار
// که مدل چند بلاک کد کوچک (مثل ```Dockerfile```) وسط متن استفاده کرده.
const REPLY_MAX_LEN = 3800; // زیر سقف واقعی تلگرام برای اطمینان

// یک متن خام را تا وقتی طول «HTML نهایی» (بعد از escape شدن < > & که کاراکتر بیشتری می‌شوند)
// از سقف بیشتر است، از وسط (ترجیحاً سر خط) نصف می‌کند. هر تکهٔ خروجی کامل و مستقل است.
function splitToFit(raw, render, maxLen) {
  const html = render(raw);
  if (html.length <= maxLen || raw.length <= 50) return [html];
  let mid = raw.lastIndexOf("\n", Math.floor(raw.length / 2));
  if (mid < raw.length * 0.25) mid = Math.floor(raw.length / 2);
  return [
    ...splitToFit(raw.slice(0, mid), render, maxLen),
    ...splitToFit(raw.slice(mid), render, maxLen)
  ];
}
__name(splitToFit, "splitToFit");

const renderCodePiece = (raw) => `<pre><code>${escapeHtml(raw)}</code></pre>`;

// متن خام را به آرایه‌ای از تکه‌های HTML «کامل و مستقل» تبدیل می‌کند (هیچ تگی نصفه نمی‌ماند)
function buildReplyPieces(rawText) {
  const segments = splitCodeBlocks(String(rawText)).filter((s) => s.content.trim().length > 0);
  const pieces = [];
  for (const seg of segments) {
    if (seg.type === "code") {
      pieces.push(...splitToFit(seg.content.trim(), renderCodePiece, REPLY_MAX_LEN));
    } else {
      // نکته‌ی مهم: این‌جا trim نمی‌کنیم — فاصله/خطِ جدید دور هر بخش متنی نگه داشته می‌شود
      // تا وقتی تکه‌ها به هم می‌چسبند (مثلاً متن کنار یک بلاک کد کوچک)، به هم قالب نشوند.
      pieces.push(...splitToFit(seg.content, formatForTelegram, REPLY_MAX_LEN));
    }
  }
  return pieces;
}
__name(buildReplyPieces, "buildReplyPieces");

// تبدیل HTML تلگرام به متن ساده (برای حالت اضطراری وقتی تلگرام HTML را نپذیرد)
function htmlToPlain(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
__name(htmlToPlain, "htmlToPlain");

// ارسال یک پیام HTML؛ اگر تلگرام با خطای ۴۰۰ (مثلاً HTML نامعتبر) ردش کرد، نسخهٔ متن ساده فرستاده می‌شود
// تا پاسخ هیچ‌وقت بی‌صدا گم نشود.
async function sendHtmlSafe(token, chatId, html) {
  const res = await sendTelegram(token, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
  if (res.ok || res.status !== 400) return;
  await sendTelegram(token, "sendMessage", { chat_id: chatId, text: htmlToPlain(html).slice(0, 4096) });
}
__name(sendHtmlSafe, "sendHtmlSafe");

async function replySmart(env, chatId, rawText) {
  const pieces = buildReplyPieces(rawText);
  if (!pieces.length) {
    await sendTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "⚠️ پاسخ خالی دریافت شد." });
    return;
  }

  let buffer = "";
  for (const piece of pieces) {
    // اگر اضافه‌کردن این تکه از سقف رد می‌شود، بافر فعلی را بفرست و یک پیام جدید شروع کن
    if (buffer && buffer.length + piece.length > REPLY_MAX_LEN) {
      await sendHtmlSafe(env.BOT_TOKEN, chatId, buffer);
      buffer = "";
    }
    buffer += piece;
  }
  if (buffer) {
    await sendHtmlSafe(env.BOT_TOKEN, chatId, buffer);
  }
}
__name(replySmart, "replySmart");

// fetch با سقف زمانی مشخص — اگر سرور طرف مقابل تا timeoutMs جواب ندهد، درخواست لغو می‌شود
// (به‌جای این‌که کل پردازش آپدیت، بی‌نهایت روی یک fetch بیرونی معلق بماند)
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");

// تابع جستجوی زنده در وب با Tavily API (با سقف زمانی ۸ ثانیه)
async function searchWeb(query, apiKey) {
  try {
    const response = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_answer: false,
        max_results: 3
      })
    }, 8000);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results.map(r => `عنوان: ${r.title}\nمنبع: ${r.url}\nخلاصه: ${r.content}`).join("\n\n");
    }
    return "نتیجه‌ای در وب یافت نشد.";
  } catch (err) {
    if (err.name === "AbortError") {
      return "جستجوی وب بیش از حد طول کشید (timeout) و نادیده گرفته شد.";
    }
    return `خطا در جستجوی وب: ${err.message}`;
  }
}
__name(searchWeb, "searchWeb");

// خواندن مدل انتخابی کاربر از KV (اگر ذخیره نشده بود، مدل پیش‌فرض برگردانده می‌شود)
async function getUserModelKey(env, chatId) {
  if (!env.CHAT_HISTORY) return DEFAULT_MODEL_KEY;
  const saved = await env.CHAT_HISTORY.get(`model_${chatId}`);
  if (saved && MODELS[saved]) return saved;
  return DEFAULT_MODEL_KEY;
}
__name(getUserModelKey, "getUserModelKey");

// 🕒 گرفتن تاریخ امروز به وقت UTC (فرمت YYYY-MM-DD)
function getUTCDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}
__name(getUTCDate, "getUTCDate");

// ⏳ محاسبه ثانیه‌های باقی‌مانده تا نیمه‌شب بعدی به وقت UTC (لحظه‌ی ریست روزانه)
function secondsUntilUTCMidnight() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date());

  const get = type => parseInt(parts.find(p => p.type === type).value, 10);

  return 86400 - (get('hour') * 3600 + get('minute') * 60 + get('second'));
}
__name(secondsUntilUTCMidnight, "secondsUntilUTCMidnight");

// 🕐 تبدیل ثانیه به متن خوانای فارسی (مثلاً «۳ ساعت و ۲۰ دقیقه» یا «۵ دقیقه»)
function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.max(1, Math.ceil((totalSeconds % 3600) / 60));
  return hours > 0 ? `${hours} ساعت و ${minutes} دقیقه` : `${minutes} دقیقه`;
}
__name(formatDuration, "formatDuration");

// 📊 دریافت مجموع نورون مصرف‌شده امروز (به وقت UTC) از GraphQL Analytics کلادفلر
// دیتاست: aiInferenceAdaptiveGroups — فیلد جمع‌شده: sum.totalNeurons
// (این اسم فیلد از خروجی واقعی introspection روی همین حساب تأیید شده، نه حدس)
async function getNeuronUsage(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;

  const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD به وقت UTC

  const query = `
    query GetTodayNeurons($accountTag: string!, $today: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          aiInferenceAdaptiveGroups(filter: { date: $today }, limit: 1000) {
            sum { totalNeurons }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: env.CF_ACCOUNT_ID, today: todayUtc }
      })
    }, 6000);
    const data = await res.json();
    if (!res.ok || data?.errors) {
      return { ok: false, raw: data };
    }
    const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
    const consumed = groups.reduce((sum, g) => sum + (g?.sum?.totalNeurons || 0), 0);
    return { ok: true, consumed, date: todayUtc };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: "درخواست وضعیت مصرف بیش از حد طول کشید (timeout)." };
    }
    return { ok: false, error: err.message };
  }
}
__name(getNeuronUsage, "getNeuronUsage");

// ساخت متن قابل‌نمایش وضعیت نورون برای پیام /start
// نکته: سقف ۱۰هزارتایی، مقداریه که خود کلادفلر برای پلن Free اعمال می‌کنه؛ از هیچ API قابل استعلام نیست،
// برای همین به‌عنوان یه عدد ثابت شناخته‌شده نگه‌داشته شده، نه چیزی که از این کوئری اومده باشه.
function formatNeuronUsage(usage) {
  if (!usage) {
    return "⚠️ برای نمایش اعتبار نورون، متغیرهای <code>CF_ACCOUNT_ID</code> و <code>CF_API_TOKEN</code> رو در تنظیمات ورکر ست کن.";
  }
  if (!usage.ok) {
    const errText = usage.error || JSON.stringify(usage.raw).slice(0, 400);
    return `⚠️ گرفتن وضعیت نورون ناموفق بود:\n<pre><code>${escapeHtml(errText)}</code></pre>`;
  }

  const FREE_DAILY_LIMIT = 10000;
  const consumed = usage.consumed;
  const remaining = Math.max(FREE_DAILY_LIMIT - consumed, 0);

  return [
    "📊 <b>وضعیت مصرف Neuron کلادفلر (امروز، به وقت UTC)</b>",
    `🔸 مصرف‌شده: <b>${consumed.toFixed(0)}</b>`,
    `🔸 سقف رایگان روزانه: <b>${FREE_DAILY_LIMIT}</b>`,
    `🔸 باقیمانده (اگه پلن Free داری): <b>${remaining.toFixed(0)}</b>`,
    "🔸 ریست: هر روز ساعت ۰۰:۰۰ به وقت UTC",
    `🔸 حدود ${formatDuration(secondsUntilUTCMidnight())} دیگه ریست می‌شه`,
    "",
    "ℹ️ اگه پلن Workers Paid داری، بعد از این سقف هم مصرفت ادامه پیدا می‌کنه ولی جداگانه هزینه‌اش حساب می‌شه."
  ].join("\n");
}
__name(formatNeuronUsage, "formatNeuronUsage");

// تبدیل ArrayBuffer به Base64 به‌صورت تکه‌تکه (برای جلوگیری از خطای call stack روی فایل‌های بزرگ)
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32KB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
__name(arrayBufferToBase64, "arrayBufferToBase64");

// دانلود پیام صوتی تلگرام (voice/audio) و تشخیص گفتار با مدل Whisper کلادفلر
async function transcribeVoice(env, fileId) {
  // ۱. گرفتن مسیر فایل از تلگرام
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) {
    throw new Error(fileInfo.description || "دریافت اطلاعات فایل صوتی از تلگرام ناموفق بود");
  }

  // ۲. دانلود بایت‌های فایل صوتی
  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`);
  if (!audioRes.ok) {
    throw new Error(`دانلود فایل صوتی از تلگرام ناموفق بود (${audioRes.status})`);
  }
  const audioBuffer = await audioRes.arrayBuffer();
  const base64Audio = arrayBufferToBase64(audioBuffer);

  // ۳. اجرای مدل Whisper (ورودی باید base64 باشد، طبق مستندات کلادفلر)
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: base64Audio
  });

  return (result?.text || "").trim() || null;
}
__name(transcribeVoice, "transcribeVoice");

// دانلود عمومی هر فایل تلگرام (عکس، سند، صوت و ...) و برگرداندن بایت‌های خام آن
async function downloadTelegramFile(env, fileId) {
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) {
    throw new Error(fileInfo.description || "دریافت اطلاعات فایل از تلگرام ناموفق بود");
  }
  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`);
  if (!fileRes.ok) {
    throw new Error(`دانلود فایل از تلگرام ناموفق بود (${fileRes.status})`);
  }
  return await fileRes.arrayBuffer();
}
__name(downloadTelegramFile, "downloadTelegramFile");

// 📄 تنظیمات خواندن PDF
const PDF_MAX_BYTES = 15 * 1024 * 1024; // حداکثر حجم فایل PDF (تلگرام خودش برای ربات‌ها سقف ۲۰ مگابایت دارد)

// 📎 تنظیمات مشترک فایل‌های متنی و PDF
const DOC_MAX_CHARS = 50000;            // حداکثر تعداد کاراکتر از محتوای فایل که به مدل داده می‌شود
const DOC_TTL_SECONDS = 6 * 60 * 60;    // فایل آخر کاربر تا ۶ ساعت (یا تا /new) برای سؤال‌های بعدی نگه داشته می‌شود

// کوتاه کردن محتوای فایل در صورت طولانی بودن
function clipDoc(content) {
  if (content.length <= DOC_MAX_CHARS) return { content, truncated: false };
  return {
    content: content.slice(0, DOC_MAX_CHARS) + "\n\n[...ادامهٔ فایل به دلیل طولانی بودن کوتاه شد...]",
    truncated: true
  };
}
__name(clipDoc, "clipDoc");

// متن کوتاهی که به‌جای «کل فایل» در تاریخچهٔ چت ذخیره می‌شود (خود فایل جداگانه در KV نگه داشته می‌شود)
function fileMessageText(fileName, instruction) {
  return `📎 فایل «${fileName || "نامشخص"}» ارسال شد.\nدرخواست: ${instruction}`;
}
__name(fileMessageText, "fileMessageText");

// استخراج متن PDF با قابلیت داخلی کلادفلر (env.AI.toMarkdown) — بدون نیاز به کتابخانه یا متغیر جدید.
// نکته: فقط متن «واقعی» داخل PDF خونده می‌شه؛ PDFهای اسکن‌شده/عکسی (بدون لایهٔ متن) خروجی خالی می‌دن.
async function extractPdfText(env, fileBuffer, fileName) {
  const makeDoc = () => ({
    name: fileName || "document.pdf",
    blob: new Blob([fileBuffer], { type: "application/pdf" })
  });

  let result;
  try {
    // خروجی متن ساده (بدون سینتکس مارک‌داون) و بدون متادیتا، تا توکن کمتری مصرف بشه
    result = await env.AI.toMarkdown(makeDoc(), {
      conversionOptions: { output: { format: "text" }, pdf: { metadata: false } }
    });
  } catch (optErr) {
    // اگر به هر دلیلی گزینه‌ها پذیرفته نشد، بدون گزینه دوباره تلاش می‌کنیم
    result = await env.AI.toMarkdown(makeDoc());
  }

  const item = Array.isArray(result) ? result[0] : result;
  if (!item) {
    throw new Error("تبدیل PDF خروجی برنگرداند.");
  }
  if (item.format === "error") {
    throw new Error(item.error || "تبدیل PDF ناموفق بود.");
  }
  return String(item.data || "").trim();
}
__name(extractPdfText, "extractPdfText");

// تحلیل تصویر با مدل Vision کلادفلر (طبق فرمت رسمی: image به‌صورت data URI base64)
async function analyzeImage(env, imageBuffer, userPrompt) {
  const base64 = arrayBufferToBase64(imageBuffer);
  const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    messages: [
      { role: "system", content: "شما یک دستیار هوشمند فارسی‌زبان هستید که تصاویر را با دقت و به‌صورت مفید توصیف و تحلیل می‌کنید." },
      { role: "user", content: userPrompt }
    ],
    image: `data:image/jpeg;base64,${base64}`
  });
  return (response?.response || response?.text || "").trim() || null;
}
__name(analyzeImage, "analyzeImage");

// تشخیص اینکه متن حاوی حروف فارسی/عربی هست یا نه
function isPersianText(text) {
  return /[\u0600-\u06FF]/.test(text);
}
__name(isPersianText, "isPersianText");

// ترجمهٔ پرامپت فارسی به یک پرامپت انگلیسی مناسب برای مدل FLUX
async function translatePromptToEnglish(env, text) {
  const translationResponse = await env.AI.run(TRANSLATE_MODEL_ID, {
    messages: [
      { role: "system", content: "Translate the user's Persian prompt into a detailed, high-quality English prompt suitable for FLUX image generation. Return ONLY the translated English prompt, with no explanations, notes, quotes, or extra text." },
      { role: "user", content: text }
    ]
  });
  let out = (translationResponse?.response || translationResponse?.text || text).trim();
  // حذف نقل‌قول یا پیشوندهایی که گاهی مدل اضافه می‌کند
  out = out.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return out || text;
}
__name(translatePromptToEnglish, "translatePromptToEnglish");

// ساخت تصویر با مدل FLUX و تبدیل خروجی base64 به بایت‌های تصویر
async function generateImage(env, prompt) {
  const response = await env.AI.run(MODELS.image.id, { prompt });
  if (!response?.image) {
    throw new Error("مدل تصویری خروجی معتبری برنگرداند.");
  }
  const binaryString = atob(response.image);
  return Uint8Array.from(binaryString, (m) => m.codePointAt(0));
}
__name(generateImage, "generateImage");

// ارسال عکس به تلگرام به‌صورت multipart/form-data
async function sendTelegramPhoto(token, chatId, imageBytes, caption) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  if (caption) formData.append("caption", caption.slice(0, 1000));
  const blob = new Blob([imageBytes], { type: "image/jpeg" });
  formData.append("photo", blob, "image.jpg");
  return fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: formData });
}
__name(sendTelegramPhoto, "sendTelegramPhoto");

// ساخت دکمه‌های شیشه‌ای انتخاب مدل برای تلگرام
function buildModelKeyboard(currentKey) {
  const rows = Object.entries(MODELS).map(([key, m]) => {
    const prefix = key === currentKey ? "✅ " : "";
    return [{ text: `${prefix}${m.label}`, callback_data: `setmodel:${key}` }];
  });
  return { inline_keyboard: rows };
}
__name(buildModelKeyboard, "buildModelKeyboard");

// پردازش فشردن دکمه‌های انتخاب مدل (callback_query)
async function handleCallbackQuery(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data || "";

  if (data.startsWith("setmodel:")) {
    const key = data.split(":")[1];
    if (MODELS[key]) {
      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.put(`model_${chatId}`, key);
      }
      await sendTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: `مدل «${MODELS[key].label}» انتخاب شد ✅`
      });
      await sendTelegram(env.BOT_TOKEN, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `مدل فعلی شما: <b>${escapeHtml(MODELS[key].label)}</b>\nشناسه: <code>${escapeHtml(MODELS[key].id)}</code>\n\nبرای تغییر دوباره، از دستور /model استفاده کن.`,
        parse_mode: "HTML",
        reply_markup: buildModelKeyboard(key)
      });
      return;
    }
  }

  // callback ناشناخته
  await sendTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
}
__name(handleCallbackQuery, "handleCallbackQuery");

// مقایسهٔ دو رشته (برای بررسی secret)
function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");

// حافظهٔ کوتاه‌مدت آپدیت‌های اخیر (در حافظهٔ همین Worker؛ برای جلوگیری از پاسخ تکراری، تلاش حداکثری است)
const recentUpdateIds = new Map();
const UPDATE_DEDUP_MS = 10 * 60 * 1000;
function isDuplicateUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;
  const now = Date.now();
  for (const [id, t] of recentUpdateIds) {
    if (now - t > UPDATE_DEDUP_MS || recentUpdateIds.size > 500) recentUpdateIds.delete(id);
    else break;
  }
  if (recentUpdateIds.has(updateId)) return true;
  recentUpdateIds.set(updateId, now);
  return false;
}
__name(isDuplicateUpdate, "isDuplicateUpdate");

// ثبت خودکار Webhook تلگرام روی آدرس همین Worker (با باز کردن آدرس /setup در مرورگر)
async function setupWebhook(request, env) {
  const headers = { "Content-Type": "text/plain; charset=utf-8" };
  if (!env.BOT_TOKEN) {
    return new Response("❌ BOT_TOKEN تنظیم نشده.", { status: 500, headers });
  }
  const payload = {
    url: new URL(request.url).origin,
    allowed_updates: ["message", "callback_query"]
  };
  if (env.WEBHOOK_SECRET) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)) {
      return new Response("❌ مقدار WEBHOOK_SECRET فقط می‌تونه شامل حروف انگلیسی، عدد، _ و - باشه (حداکثر ۲۵۶ کاراکتر).", { status: 400, headers });
    }
    payload.secret_token = env.WEBHOOK_SECRET;
  }
  try {
    const res = await sendTelegram(env.BOT_TOKEN, "setWebhook", payload);
    const data = await res.json();
    if (data.ok) {
      return new Response(`✅ Webhook ثبت شد.${env.WEBHOOK_SECRET ? " (محافظت با WEBHOOK_SECRET فعاله)" : ""}\nحالا به ربات توی تلگرام پیام بده.`, { status: 200, headers });
    }
    return new Response(`❌ تلگرام خطا داد: ${data.description || "نامشخص"}`, { status: 502, headers });
  } catch (err) {
    return new Response(`❌ خطا در ثبت Webhook: ${err.message}`, { status: 502, headers });
  }
}
__name(setupWebhook, "setupWebhook");

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      // /setup: ثبت خودکار Webhook (با secret_token اگر WEBHOOK_SECRET تنظیم شده باشد)
      if (new URL(request.url).pathname === "/setup") {
        return await setupWebhook(request, env);
      }
      return new Response("Telegram Bot AI Server is running!", { status: 200 });
    }

    // 🔐 اگر WEBHOOK_SECRET تنظیم شده باشد، فقط درخواست‌هایی که هدر مخصوص تلگرام را با همین مقدار دارند پذیرفته می‌شوند
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!safeEqual(got, env.WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch (parseErr) {
      return new Response("Bad Request", { status: 400 });
    }

    // ♻️ تلگرام اگر جواب را دیر بگیرد همان آپدیت را دوباره می‌فرستد؛ تکراری‌ها نادیده گرفته می‌شوند
    if (isDuplicateUpdate(update?.update_id)) {
      return new Response("OK", { status: 200 });
    }

    // 🚀 نکتهٔ کلیدی برای پایداری روی Cloudflare Workers: تلگرام برای هر آپدیت حدود ۶۰ ثانیه منتظر
    // جواب HTTP می‌مونه؛ اگه دیرتر جواب بگیره ارتباط رو قطع می‌کنه (دقیقاً همون چیزی که توی لاگ‌های
    // Worker به‌صورت outcome:"canceled" و wallTimeMs نزدیک به ۶۰۰۰۰ دیده می‌شه) و همون آپدیت رو
    // دوباره ارسال می‌کنه. برای همین این‌جا فوراً «OK» برمی‌گردونیم و کل کار واقعی (فراخوانی مدل
    // هوش مصنوعی، دانلود فایل، سرچ وب و ...) رو با ctx.waitUntil در پس‌زمینه ادامه می‌دیم — این
    // پس‌زمینه دیگه به جواب HTTP وابسته نیست و محدودیت ۶۰ ثانیه‌ای وبهوک تلگرام روش تأثیری نداره.
    ctx.waitUntil(
      handleUpdate(env, update).catch((err) => {
        console.error("خطای پردازش آپدیت:", err);
      })
    );

    return new Response("OK", { status: 200 });
  }
};

// 🧠 کل منطق واقعی پردازش یک آپدیت تلگرام. چون این تابع در پس‌زمینه (ctx.waitUntil) اجرا می‌شود و
// دیگر هیچ پاسخ HTTP منتظرش نیست، دیگر لازم نیست چیزی return شود؛ فقط برای خروج زودهنگام از
// `return;` (بدون مقدار) استفاده شده — قبلاً همین نقطه‌ها `return new Response("OK", ...)` بودند.
async function handleUpdate(env, update) {
  let chatId = null;
  try {
      // 🔒 بررسی مجاز بودن کاربر — قبل از هر پردازش دیگری
      const incomingUserId = update?.message?.from?.id ?? update?.callback_query?.from?.id ?? null;
      if (!isAuthorized(env, incomingUserId)) {
        if (update?.callback_query) {
          await sendTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
            callback_query_id: update.callback_query.id,
            text: "⛔ شما اجازه استفاده از این ربات را ندارید.",
            show_alert: true
          });
        } else if (update?.message) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: update.message.chat.id,
            text: "⛔ این ربات خصوصی است و فقط برای کاربران مجاز در دسترس است."
          });
        }
        return;
      }

      // 🔘 فشردن یکی از دکمه‌های شیشه‌ای (مثلاً انتخاب مدل)
      if (update?.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
        return;
      }

      if (!update?.message) {
        return;
      }

      chatId = update.message.chat.id;
      let text = null;
      let isFileMessage = false; // اگر پیام یک فایل (متنی/PDF) باشد، سرچ وب انجام نمی‌شود
      let pendingDoc = null;     // محتوای فایلِ همین پیام: { name, content } — جدا از تاریخچهٔ چت نگه داشته می‌شود

      // 🖼 عکس: مستقیم با مدل Vision تحلیل می‌شود (مسیر جدا، وابسته به مدل چت انتخابی کاربر نیست)
      if (update.message.photo && update.message.photo.length > 0) {
        await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "typing" });
        try {
          const largestPhoto = update.message.photo[update.message.photo.length - 1];
          const imageBuffer = await downloadTelegramFile(env, largestPhoto.file_id);
          const userPrompt = (update.message.caption && update.message.caption.trim()) || "این تصویر را با جزئیات توصیف و تحلیل کن.";
          const analysis = await analyzeImage(env, imageBuffer, userPrompt);
          if (!analysis) {
            throw new Error("مدل تصویری خروجی متنی برنگرداند.");
          }
          await replySmart(env, chatId, analysis);
        } catch (imgAnalysisErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 تحلیل تصویر ناموفق بود:\n<pre><code>${escapeHtml(imgAnalysisErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
        }
        return;
      }

      // 📄 فایل متنی/کد (txt, html, js, css, json, py, md و ...): محتوا خونده می‌شه
      // و مثل یک پیام متنی وارد پایپ‌لاین اصلی می‌شه. همهٔ این‌ها متن ساده‌ن (نه باینری)،
      // پس همون منطق دانلود+دیکود UTF-8 برای همه‌شون کار می‌کنه.
      const doc = update.message.document;
      const TEXT_FILE_EXTENSIONS = /\.(txt|md|markdown|html?|css|js|jsx|mjs|ts|tsx|json|jsonc|xml|yaml|yml|csv|py|php|java|c|cpp|h|cs|rb|go|rs|sh|bash|sql|ini|env|log|conf|toml|svg)$/i;
      const isTextFile =
        doc &&
        (
          (doc.mime_type && doc.mime_type.startsWith("text/")) ||
          [
            "application/json",
            "application/javascript",
            "application/xml",
            "application/x-sh",
            "application/x-yaml",
            "application/x-httpd-php",
            "image/svg+xml"
          ].includes(doc.mime_type || "") ||
          TEXT_FILE_EXTENSIONS.test(doc.file_name || "")
        );
      const isPdf =
        doc &&
        !isTextFile &&
        (doc.mime_type === "application/pdf" || /\.pdf$/i.test(doc.file_name || ""));
      if (doc && !isTextFile && !isPdf) {
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "📎 این فرمت فایل پشتیبانی نمی‌شه. فایل PDF و فایل‌های متنی/کد (مثل txt, html, js, css, json, py, md) رو می‌تونی بفرستی؛ فایل‌های باینری مثل Word/Excel فعلاً پشتیبانی نمی‌شن."
        });
        return;
      }
      if (isTextFile) {
        await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "typing" });
        try {
          const fileBuffer = await downloadTelegramFile(env, doc.file_id);
          const clipped = clipDoc(new TextDecoder("utf-8").decode(fileBuffer));
          if (clipped.truncated) {
            await sendTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `⚠️ این فایل طولانیه؛ فقط ${DOC_MAX_CHARS.toLocaleString("en-US")} کاراکتر اولش خونده شد.`
            });
          }
          const instruction = (update.message.caption && update.message.caption.trim()) || "این فایل را بررسی، خلاصه و تحلیل کن.";
          pendingDoc = { name: doc.file_name || "نامشخص", content: clipped.content };
          text = fileMessageText(doc.file_name, instruction);
          isFileMessage = true;
        } catch (docErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 خواندن فایل ناموفق بود:\n<pre><code>${escapeHtml(docErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
          return;
        }
      } else if (isPdf) {
        // 📄 فایل PDF: متن داخلش استخراج می‌شه و مثل یک پیام متنی وارد پایپ‌لاین اصلی می‌شه
        await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "typing" });
        try {
          if (doc.file_size && doc.file_size > PDF_MAX_BYTES) {
            await sendTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `📄 حجم این PDF بیشتر از ${PDF_MAX_BYTES / (1024 * 1024)} مگابایته و نمی‌تونم بخونمش. یه فایل کم‌حجم‌تر یا چند صفحهٔ اولش رو بفرست.`
            });
            return;
          }

          const pdfBuffer = await downloadTelegramFile(env, doc.file_id);
          let pdfContent = await extractPdfText(env, pdfBuffer, doc.file_name);

          if (!pdfContent) {
            await sendTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: "📄 هیچ متنی داخل این PDF پیدا نکردم. احتمالاً اسکن‌شده یا عکسیه (متن قابل انتخاب نداره). اگه صفحه‌ها رو به‌صورت عکس بفرستی، می‌تونم با تحلیل تصویر بررسی‌شون کنم."
            });
            return;
          }

          const clippedPdf = clipDoc(pdfContent);
          if (clippedPdf.truncated) {
            await sendTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `⚠️ این PDF طولانیه؛ فقط ${DOC_MAX_CHARS.toLocaleString("en-US")} کاراکتر اولش خونده شد.`
            });
          }

          const pdfInstruction = (update.message.caption && update.message.caption.trim()) || "این فایل را بررسی، خلاصه و تحلیل کن.";
          pendingDoc = { name: doc.file_name || "نامشخص", content: clippedPdf.content };
          text = fileMessageText(doc.file_name, pdfInstruction);
          isFileMessage = true;
        } catch (pdfErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 خواندن PDF ناموفق بود:\n<pre><code>${escapeHtml(pdfErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
          return;
        }
      } else if (update.message.voice || update.message.audio) {
        const voiceObj = update.message.voice || update.message.audio;
        await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "typing" });
        try {
          text = await transcribeVoice(env, voiceObj.file_id);
        } catch (voiceErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 تشخیص گفتار ناموفق بود:\n<pre><code>${escapeHtml(voiceErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
          return;
        }

        if (!text) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "🎙 متوجه نشدم چی گفتی؛ صدا واضح نبود یا حرفی توش شناسایی نشد."
          });
          return;
        }

        // نمایش متن شناسایی‌شده به کاربر برای شفافیت (و قابل کپی بودن)
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🎙 متن شناسایی‌شده:\n<blockquote>${escapeHtml(text)}</blockquote>`,
          parse_mode: "HTML"
        });
      } else if (update.message.text) {
        text = update.message.text.trim();
      } else {
        // نوع پیام پشتیبانی‌نشده (عکس، استیکر و ...)
        return;
      }

      // 🆕 شروع مکالمهٔ جدید: تاریخچهٔ چت این کاربر از KV پاک می‌شه تا مدل دیگه موضوع قبلی رو ادامه نده
      if (text === "/new" || text === "/clear" || text === "/reset") {
        if (env.CHAT_HISTORY) {
          await env.CHAT_HISTORY.delete(`chat_${chatId}`);
          await env.CHAT_HISTORY.delete(`doc_${chatId}`);
        }
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "🆕 مکالمهٔ جدید شروع شد؛ حافظهٔ گفتگوی قبلی پاک شد."
        });
        return;
      }

      // 🧭 تأیید یک‌بارهٔ لایسنس مدل Vision (لازم قبل از اولین استفاده از تحلیل عکس)
      if (text === "/agreevision") {
        try {
          const licenseRes = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" });
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `✅ لایسنس مدل تحلیل تصویر (Llama 3.2 Vision) تأیید شد.\n\nپاسخ کلادفلر:\n<pre><code>${escapeHtml(JSON.stringify(licenseRes).slice(0, 500))}</code></pre>\n\nحالا می‌تونی عکس بفرستی تا تحلیلش کنم.`,
            parse_mode: "HTML"
          });
        } catch (licenseErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 تأیید لایسنس ناموفق بود:\n<pre><code>${escapeHtml(licenseErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
        }
        return;
      }

      // 🧭 دستور نمایش/تغییر مدل
      if (text === "/model" || text === "/models") {
        const currentKey = await getUserModelKey(env, chatId);
        const neuronUsage = await getNeuronUsage(env);
        const neuronText = formatNeuronUsage(neuronUsage);
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
      text: `سلام! من دستیار هوشمند شما هستم 🤖\n\n${neuronText}\n\nمدل فعلی: <b>${escapeHtml(MODELS[currentKey].label)}</b>\nشناسه: <code>${escapeHtml(MODELS[currentKey].id)}</code>\n\nیکی از مدل‌های زیر رو انتخاب کن:`,
          parse_mode: "HTML",
          reply_markup: buildModelKeyboard(currentKey)
        });
        return;
      }

      // 🧭 دستور شروع
      if (text === "/start") {
        const currentKey = await getUserModelKey(env, chatId);
        const neuronUsage = await getNeuronUsage(env);
        const neuronText = formatNeuronUsage(neuronUsage);
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `سلام! من دستیار هوشمند شما هستم 🤖
چت، ارسال فایل صوتی و تصویری، خواندن PDF و فایل‌های متنی، و ساخت تصویر
\n\n${neuronText}\n\nمدل فعلی: <b>${escapeHtml(MODELS[currentKey].label)}</b>\n\nهر سوالی داری بپرس. برای تغییر مدل، دستور /model رو بفرست. برای فعال‌سازی تحلیل تصویر (فقط یک‌بار لازمه)، دستور /agreevision  دو بار رو بفرست. برای شروع یه مکالمهٔ تازه (پاک کردن حافظهٔ گفتگوی قبلی)، دستور /new رو بفرست.`,
          parse_mode: "HTML"
        });
        return;
      }

      // ارسال وضعیت typing به تلگرام
      await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "typing" });

      // مدل انتخابی همین کاربر
      const modelKey = await getUserModelKey(env, chatId);
      const MODEL_ID = MODELS[modelKey].id;

      // 🎨 اگر کاربر گزینهٔ «ساخت تصویر» رو انتخاب کرده، مسیر کاملاً جدا از چت متنی طی می‌شود
      if (MODELS[modelKey].type === "image") {
        if (isFileMessage) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "📎 برای خوندن فایل باید یکی از مدل‌های چت رو انتخاب کنی. دستور /model رو بفرست و مدل چت رو انتخاب کن، بعد فایل رو دوباره بفرست."
          });
          return;
        }
        await sendTelegram(env.BOT_TOKEN, "sendChatAction", { chat_id: chatId, action: "upload_photo" });
        try {
          const persian = isPersianText(text);
          const englishPrompt = persian ? await translatePromptToEnglish(env, text) : text;
          const imgBytes = await generateImage(env, englishPrompt);

          const captionLines = [`🎨 پرامپت: ${text}`];
          if (persian) captionLines.push(`🔤 ترجمه: ${englishPrompt}`);

          await sendTelegramPhoto(env.BOT_TOKEN, chatId, imgBytes, captionLines.join("\n"));
        } catch (imgErr) {
          await sendTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🚨 ساخت تصویر ناموفق بود:\n<pre><code>${escapeHtml(imgErr.message)}</code></pre>`,
            parse_mode: "HTML"
          });
        }
        return;
      }

      // 🕒 محاسبه دقیق‌ترین ساعت و تاریخ زنده به وقت تهران (برای حل مشکل قفل زمانی کلاودفلر)
      const now = new Date();
      const timeOptions = { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false };
      const dateOptions = { timeZone: 'Asia/Tehran', calendar: 'persian', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };

      const currentTimeIran = now.toLocaleTimeString('fa-IR', timeOptions);
      const currentDateIran = now.toLocaleDateString('fa-IR', dateOptions);

      // انجام سرچ زنده در اینترنت
      let webResults = "کاربر سوالی نپرسیده که نیاز به سرچ داشته باشد.";
      if (env.TAVILY_API_KEY && !isFileMessage) {
        // Tavily فقط کوئری کوتاه می‌پذیرد؛ محتوای کامل فایل هرگز به‌عنوان کوئری سرچ فرستاده نمی‌شود
        webResults = await searchWeb(text.slice(0, 400), env.TAVILY_API_KEY);
      }

      // 📎 فایل فعال کاربر: اگر همین پیام فایل دارد ذخیره می‌شود، وگرنه آخرین فایل قبلی (تا ۶ ساعت) خوانده می‌شود.
      // محتوای فایل فقط در پرامپت سیستم می‌آید (یک نسخه)، نه در تاریخچهٔ چت که هر بار تکرار شود.
      let activeDoc = null;
      if (pendingDoc) {
        activeDoc = pendingDoc;
        if (env.CHAT_HISTORY) {
          await env.CHAT_HISTORY.put(`doc_${chatId}`, JSON.stringify(pendingDoc), { expirationTtl: DOC_TTL_SECONDS });
        }
      } else if (env.CHAT_HISTORY) {
        const savedDoc = await env.CHAT_HISTORY.get(`doc_${chatId}`);
        if (savedDoc) {
          try { activeDoc = JSON.parse(savedDoc); } catch (e) { activeDoc = null; }
        }
      }
      const docBlock = activeDoc
        ? `\n\n[فایل پیوست‌شدهٔ کاربر: ${activeDoc.name}]\n\"\"\"\n${activeDoc.content}\n\"\"\"\nهر وقت کاربر دربارهٔ «فایل»، «این متن» یا «این سند» پرسید، پاسخ را بر اساس محتوای همین فایل بده.`
        : "";

      // ساخت پرامپت سیستم پویا و تزریق ساعت زنده ایران + اطلاعات وب
      const dynamicSystemPrompt = `تو یک دستیار هوشمند بسیار صمیمی، دانا و متصل به اینترنت زنده هستی.
پاسخ کاربران را کاملاً به زبان فارسی روان، جذاب و شیک بده.

[اطلاعات زمانی دقیق و زنده سیستم]:
- امروز: ${currentDateIran}
- ساعت دقیق هم‌اکنون در ایران (تهران): ساعت ${currentTimeIran}

تو به زمان زنده کاملاً دسترسی داری. مبنای ساعت تو دقیقاً ساعت ${currentTimeIran} است. اگر کاربر ساعت را پرسید، دقیقاً همین ساعت را اعلام کن. نیازی به محاسبات ذهنی یا تبدیل UTC نداری.

از این به بعد، در تمام خروجی‌های خودت مربوط به تاریخ شمسی، فقط و فقط از **سال شاهنشاهی** به عنوان مبنای تاریخ ایرانی استفاده کن.  
در هر مطلب، هر جا، و تحت هر شرایطی:
استفاده از تاریخ شمسی فعلی برای تو ممنوع هست
- اگر لازم است تاریخی ذکر کنی، آن را به صورت **سال شاهنشاهی** بنویس.  
- اگر منبع/متن تو تاریخ دیگری دارد، همان را تبدیل کن و فقط معادل **سال شاهنشاهی** را گزارش کن.  
مثلا 1405+1180=2585  یا ۱۴۰۵+۱۱۸۰ =۲۵۸۵ و از حاصل استفاده کن
- قالب را همین‌طور نگه دار: «سال شاهنشاهی: XXXX»  

این دستور را در کل گفتگو رعایت کن و هیچ استثنایی نگذار.»
بدون هیچ توضح اضافه که چرا این تبدیل انجام شده

[اطلاعات زنده دریافت شده از اینترنت درباره سوال کاربر]:
\"\"\"
${webResults}
\"\"\"

${docBlock}

وظیفه تو: با استفاده از اطلاعات زنده بالا و زمان دقیق ایران، پاسخ کاربر را بنویس.`;

      // بازیابی تاریخچه چت از حافظه KV
      let history = [];
      if (env.CHAT_HISTORY) {
        const savedHistory = await env.CHAT_HISTORY.get(`chat_${chatId}`);
        if (savedHistory) {
          history = JSON.parse(savedHistory);
        }
      }

      // اضافه کردن پیام جدید کاربر به تاریخچه
      history.push({ role: "user", content: text });

      // ترکیب پرامپت سیستم با کل تاریخچه چت
      const messages = [
        { role: "system", content: dynamicSystemPrompt },
        ...history
      ];

      // اجرای هوش مصنوعی کلادفلر با مدل انتخابی کاربر
      // max_tokens بالاتره چون مدل‌های reasoning (مثل Gemma-4) بخشی از سهمیه رو صرف
      // «فکر کردن» داخلی (reasoning_content) می‌کنن؛ با سقف پایین، جواب نهایی اصلاً نوشته نمی‌شه.
      let aiResponse;
      try {
        aiResponse = await env.AI.run(MODEL_ID, {
          messages: messages,
          max_tokens: 4096,
          stream: false
        });
      } catch (aiErr) {
        // خطای مربوط به خود مدل (مثلاً مدل موجود نیست) را همراه با شناسه مدل گزارش می‌کنیم
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🚨 مدل «${escapeHtml(MODELS[modelKey].label)}» (<code>${escapeHtml(MODEL_ID)}</code>) در دسترس نیست یا خطا داد:\n<pre><code>${escapeHtml(aiErr.message)}</code></pre>\n\nبا /model یه مدل دیگه انتخاب کن.`,
          parse_mode: "HTML"
        });
        return;
      }

      // پشتیبانی از فرمت‌های مختلف خروجی مدل‌ها (دقیقاً مطابق منطق تستر مرورگر)
      let aiText = aiResponse?.response || aiResponse?.text || null;

      // برخی مدل‌های جدیدتر (مثل gemma-sea-lion، gpt-oss) فرمت OpenAI-compatible برمی‌گردونن
      if (!aiText && aiResponse?.choices && aiResponse.choices[0]) {
        aiText = aiResponse.choices[0].message?.content || aiResponse.choices[0].text || null;
      }

      // اگه content خالی بود و دلیلش رسیدن به سقف max_tokens (نه پایان طبیعی) بود،
      // یعنی مدل کل سهمیه رو صرف reasoning داخلی کرده و به جواب نهایی نرسیده —
      // نشون دادن reasoning_content خام به‌جای جواب گمراه‌کننده‌ست، پس پیام روشن می‌دیم.
      const cutOffByLength = aiResponse?.choices?.[0]?.finish_reason === "length";
      if (!aiText && cutOffByLength && aiResponse?.choices?.[0]?.reasoning_content) {
        aiText = "⚠️ مدل قبل از رسیدن به جواب نهایی، به سقف طول پاسخ رسید (بیشتر سهمیه صرف «فکر کردن» داخلی شد). لطفاً دوباره امتحان کن یا سؤال رو کوتاه‌تر/دقیق‌تر بپرس.";
      }

      // مدل‌های reasoning (حالت‌های دیگه) ممکنه خروجی رو در reasoning_content بدن
      if (!aiText && aiResponse?.reasoning_content) {
        aiText = aiResponse.reasoning_content;
      }

      if (!aiText) {
        aiText = aiResponse?.result?.response || aiResponse?.output_text || null;
      }

      // ارسال پاسخ به تلگرام و ذخیره در حافظه KV
      if (aiText) {
        history.push({ role: "assistant", content: aiText.trim() });

        if (history.length > MAX_HISTORY * 2) {
          history = history.slice(-MAX_HISTORY * 2);
        }

        if (env.CHAT_HISTORY) {
          await env.CHAT_HISTORY.put(`chat_${chatId}`, JSON.stringify(history));
        }

        await replySmart(env, chatId, aiText.trim());
      } else {
        // برای عیب‌یابی، بخشی از خروجی خام مدل رو هم نشون می‌دیم تا بشه فرمت واقعی رو دید
        const rawPreview = JSON.stringify(aiResponse).slice(0, 500);
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🤖 پاسخ خالی از مدل «${escapeHtml(MODELS[modelKey].label)}» دریافت شد.\n\nخروجی خام (برای عیب‌یابی):\n<pre><code>${escapeHtml(rawPreview)}</code></pre>`,
          parse_mode: "HTML"
        });
      }

      return;
  } catch (error) {
      if (chatId) {
        await sendTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🚨 خطای سرور کلاودفلر:\n<pre><code>${escapeHtml(error.message)}</code></pre>`,
          parse_mode: "HTML"
        });
      }
  }
}

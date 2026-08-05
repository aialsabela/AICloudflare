/**
 * ربات تلگرام رایگان روی Cloudflare Workers
 * - دریافت پیام از تلگرام (Webhook)
 * - گرفتن جواب از Cloudflare Workers AI (رایگان)
 * - ارسال جواب به کاربر در تلگرام
 *
 * لازم است این Secret ها روی Cloudflare تنظیم شوند:
 *   TELEGRAM_BOT_TOKEN   -> توکنی که از BotFather می‌گیرید
 *   WEBHOOK_SECRET       -> یک رشته‌ی دلخواه برای امنیت webhook (خودتان انتخاب کنید)
 *
 * و در wrangler.toml باید AI binding فعال باشد (نمونه در فایل پیوست).
 */

const SYSTEM_PROMPT =
  "تو یک دستیار هوشمند و مفید هستی که به فارسی و به‌طور خلاصه و روشن جواب می‌دهی.";

// مدل رایگان متن‌باز روی Cloudflare Workers AI
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

export default {
  async fetch(request, env, ctx) {
    // فقط درخواست‌های POST از تلگرام پذیرفته می‌شود
    if (request.method !== "POST") {
      return new Response("این آدرس فقط برای Webhook تلگرام است.", { status: 200 });
    }

    // بررسی امنیتی: تلگرام هدر مخفی ما را برمی‌گرداند
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    const message = update.message;
    if (!message || !message.text) {
      // پیام‌های غیرمتنی (عکس، استیکر و ...) فعلاً نادیده گرفته می‌شوند
      return new Response("ok");
    }

    const chatId = message.chat.id;
    const userText = message.text;

    // دستور شروع
    if (userText === "/start") {
      await env.CHAT_HISTORY.delete(`history:${chatId}`);
      await sendTelegramMessage(env, chatId, "سلام! من یک ربات هوش مصنوعی هستم. هر سوالی داری بپرس 🙂");
      return new Response("ok");
    }

    // دستور پاک کردن حافظه‌ی مکالمه
    if (userText === "/reset") {
      await env.CHAT_HISTORY.delete(`history:${chatId}`);
      await sendTelegramMessage(env, chatId, "حافظه‌ی مکالمه پاک شد. از اول شروع می‌کنیم 🔄");
      return new Response("ok");
    }

    try {
      // خواندن تاریخچه‌ی قبلی مکالمه از KV
      const historyKey = `history:${chatId}`;
      const stored = await env.CHAT_HISTORY.get(historyKey);
      const history = stored ? JSON.parse(stored) : [];

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userText },
      ];

      const aiResponse = await env.AI.run(MODEL, { messages });
      const replyText = aiResponse.response || "متاسفم، نتونستم جواب بدم. دوباره امتحان کن.";

      // به‌روزرسانی تاریخچه (فقط ۱۰ پیام آخر نگه داشته می‌شود تا حجم زیاد نشود)
      const updatedHistory = [
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: replyText },
      ].slice(-10);

      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(updatedHistory), {
        expirationTtl: 60 * 60 * 24 * 3, // بعد از ۳ روز بی‌استفاده بودن، خودکار پاک می‌شود
      });

      await sendTelegramMessage(env, chatId, replyText);
    } catch (err) {
      await sendTelegramMessage(env, chatId, "یک خطا پیش اومد، لطفاً کمی بعد دوباره امتحان کن.");
    }

    return new Response("ok");
  },
};

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });
}

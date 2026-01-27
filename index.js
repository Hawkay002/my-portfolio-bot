const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;

// --- 2. DUMMY WEB SERVER (Required for UptimeRobot & Render) ---
const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running securely. UptimeRobot can ping this.');
});
app.listen(PORT, () => {
  console.log(`✅ Web Server running on port ${PORT}`);
});

// --- 3. FIREBASE INITIALIZATION ---
if (!BOT_TOKEN || !SERVICE_ACCOUNT) {
  console.error("❌ CRITICAL ERROR: Missing 'BOT_TOKEN' or 'FIREBASE_SERVICE_ACCOUNT' Env Vars.");
  process.exit(1);
}

try {
  const serviceAccountConfig = JSON.parse(SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountConfig)
  });
  console.log("✅ Firebase Admin Connected");
} catch (error) {
  console.error("❌ Firebase Init Error:", error.message);
  process.exit(1);
}

const db = admin.firestore();
const bot = new Telegraf(BOT_TOKEN);

// --- 4. HELPER: Generate 6-Digit OTP ---
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- 5. BOT LOGIC ---
bot.start(async (ctx) => {
  // Capture the param from the link: t.me/MyBot?start=session_123
  const sessionId = ctx.startPayload; 
  const user = ctx.from;

  console.log(`📩 Request from: ${user.first_name} (ID: ${user.id})`);

  // Scenario A: User opens bot directly (No link)
  if (!sessionId) {
    return ctx.reply("👋 Welcome! Please click the 'Verify via Telegram' button on the portfolio website to get your code.");
  }

  // Scenario B: User came from Website
  const otp = generateOTP();

  try {
    // 1. Save OTP to Firestore (Frontend listens for this ID)
    await db.collection('otp_sessions').doc(sessionId).set({
      otp: otp,
      telegram_id: user.id,
      telegram_name: user.first_name || 'Hidden',
      verified: false, // Frontend will update this later
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Reply to User
    await ctx.reply(
      `🔐 *Verification Code*\n\nHello ${user.first_name}! Your code is:\n\n\`${otp}\`\n\n(Tap the code to copy)`,
      { parse_mode: 'Markdown' }
    );
    console.log(`✅ Generated OTP ${otp} for Session ${sessionId}`);

  } catch (error) {
    console.error("❌ DB Write Error:", error);
    ctx.reply("⚠️ System Error. Please try again later.");
  }
});

// --- 6. LAUNCH ---
bot.launch();
console.log("🚀 Telegram Bot Started...");

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

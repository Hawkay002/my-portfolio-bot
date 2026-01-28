const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const path = require('path');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;

// --- 2. WEB SERVER (Privacy Policy + Uptime) ---
const app = express();

// A. Serve Static Files (Makes public/privacy.html accessible)
// This is critical for the BotFather privacy link
app.use(express.static(path.join(__dirname, 'public')));

// B. Root Route (Fallback/Uptime Check)
app.get('/', (req, res) => {
  res.send('Bot is running securely. Go to /privacy.html to view the policy.');
});

// C. Direct Route (Optional backup if static fails)
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
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

// A. HANDLE /start COMMAND
bot.start(async (ctx) => {
  const sessionId = ctx.startPayload; 
  const user = ctx.from;

  console.log(`📩 Start Request from: ${user.first_name} (ID: ${user.id})`);

  // Scenario 1: User opens bot directly (No session ID)
  if (!sessionId) {
    return ctx.reply("👋 Welcome! Please go to the website and click 'Verify via Telegram' to start.");
  }

  // Scenario 2: Valid Session - Ask for Contact
  try {
    // We must save the session ID temporarily because the 'contact' event 
    // is a separate message and won't have the startPayload.
    await db.collection('pending_verifications').doc(user.id.toString()).set({
      session_id: sessionId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    await ctx.reply(
      "🔐 *Security Check*\n\nTo verify your identity and receive your code, please tap the button below to share your phone number.",
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          Markup.button.contactRequest('📱 Share Phone Number')
        ]).resize().oneTime()
      }
    );

  } catch (error) {
    console.error("❌ Start Error:", error);
    ctx.reply("⚠️ System Error. Please try again.");
  }
});

// B. HANDLE CONTACT SHARING
bot.on('contact', async (ctx) => {
  const user = ctx.from;
  const contact = ctx.message.contact;

  // Security: Ensure the contact shared belongs to the sender
  if (contact.user_id !== user.id) {
    return ctx.reply("⚠️ Error: Please share your own contact.");
  }

  try {
    // 1. Retrieve the pending Session ID
    const pendingDocRef = db.collection('pending_verifications').doc(user.id.toString());
    const pendingDoc = await pendingDocRef.get();

    if (!pendingDoc.exists) {
      return ctx.reply("⚠️ Session expired. Please click 'Verify via Telegram' on the website again.", Markup.removeKeyboard());
    }

    const sessionId = pendingDoc.data().session_id;
    const otp = generateOTP();

    // 2. Save Full Details (Phone, Username, etc.) to Firestore
    await db.collection('otp_sessions').doc(sessionId).set({
      otp: otp,
      telegram_id: user.id,
      telegram_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      telegram_username: user.username || 'No Username',
      phone_number: contact.phone_number,
      verified: false,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Clean up pending doc
    await pendingDocRef.delete();

    // 4. Send OTP to User
    await ctx.reply(
      `✅ *Verification Successful*\n\nYour code is:\n\`${otp}\`\n\n(Tap to copy)`,
      { 
        parse_mode: 'Markdown',
        ...Markup.removeKeyboard() 
      }
    );

    console.log(`✅ Saved Data for User: ${user.username || user.id}`);

  } catch (error) {
    console.error("❌ Contact Error:", error);
    ctx.reply("⚠️ Error processing contact. Try again.");
  }
});

// --- 6. LAUNCH ---
bot.launch();
console.log("🚀 Telegram Bot Started...");

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

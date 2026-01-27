const { Telegraf, Markup } = require('telegraf'); // Added Markup
const admin = require('firebase-admin');
const express = require('express');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;

// --- 2. DUMMY WEB SERVER ---
const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running securely.');
});
app.listen(PORT, () => {
  console.log(`✅ Web Server running on port ${PORT}`);
});

// --- 3. FIREBASE INITIALIZATION ---
if (!BOT_TOKEN || !SERVICE_ACCOUNT) {
  console.error("❌ Missing Env Vars.");
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
  const sessionId = ctx.startPayload; // Get session ID from link
  const user = ctx.from;

  console.log(`📩 Start Request from: ${user.first_name} (ID: ${user.id})`);

  // Scenario 1: Direct link without session ID
  if (!sessionId) {
    return ctx.reply("👋 Welcome! Please go to the website and click 'Verify via Telegram' to start.");
  }

  // Scenario 2: Valid Session - Ask for Contact
  try {
    // We save a temporary "pending" record mapping Telegram ID -> Session ID
    // This is needed because the 'contact' event doesn't carry the startPayload
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
    // 1. Find the pending Session ID for this user
    const pendingDocRef = db.collection('pending_verifications').doc(user.id.toString());
    const pendingDoc = await pendingDocRef.get();

    if (!pendingDoc.exists) {
      return ctx.reply("⚠️ Session expired. Please click 'Verify via Telegram' on the website again.", Markup.removeKeyboard());
    }

    const sessionId = pendingDoc.data().session_id;
    const otp = generateOTP();

    // 2. Save Full Details to 'otp_sessions' (The main collection)
    await db.collection('otp_sessions').doc(sessionId).set({
      otp: otp,
      telegram_id: user.id,
      telegram_name: [user.first_name, user.last_name].filter(Boolean).join(' '), // Full Name
      telegram_username: user.username || 'No Username', // Capture Username
      phone_number: contact.phone_number, // Capture Phone Number
      verified: false,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Clean up the pending record
    await pendingDocRef.delete();

    // 4. Send Code to User & Remove Keyboard
    await ctx.reply(
      `✅ *Verification Successful*\n\nYour code is:\n\`${otp}\`\n\n(Tap to copy)`,
      { 
        parse_mode: 'Markdown',
        ...Markup.removeKeyboard() 
      }
    );

    console.log(`✅ Saved Data for User: ${user.username || user.id} | Phone: ${contact.phone_number}`);

  } catch (error) {
    console.error("❌ Contact Error:", error);
    ctx.reply("⚠️ Error processing contact. Try again.");
  }
});

// --- 6. LAUNCH ---
bot.launch();
console.log("🚀 Telegram Bot Started with Contact Request...");

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

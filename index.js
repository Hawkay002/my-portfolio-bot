const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const path = require('path');

// --- 1. CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;
const ADMIN_ID = 1299129410; // Your Chat ID

// --- 2. WEB SERVER (Privacy Policy + Uptime) ---
const app = express();

// A. Serve Static Files (Makes public/privacy.html accessible)
app.use(express.static(path.join(__dirname, 'public')));

// B. Root Route (Fallback/Uptime Check)
app.get('/', (req, res) => {
  res.send('Bot is running securely. Go to /privacy.html to view the policy.');
});

// C. Direct Route
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Web Server running on port ${PORT}`);
});

// --- 3. FIREBASE INITIALIZATION ---
if (!BOT_TOKEN || !SERVICE_ACCOUNT) {
  console.error("❌ CRITICAL ERROR: Missing Env Vars.");
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

// --- 4. HELPERS ---
const addCodeSessions = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateResourceCode() {
  return `REDM-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

function getUptime() {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  return `${hours}h ${minutes}m ${seconds}s`;
}

// --- 5. BOT LOGIC ---

// A. HANDLE /start COMMAND
bot.start(async (ctx) => {
  const sessionId = ctx.startPayload; 
  const user = ctx.from;

  console.log(`📩 Start Request from: ${user.first_name} (ID: ${user.id})`);

  if (!sessionId) {
    return ctx.reply("👋 Welcome! Please go to the website and click 'Verify via Telegram' to start.");
  }

  try {
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

// B. HANDLE /addcodes (ADMIN ONLY)
bot.command('addcodes', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Unauthorized.");
  
  addCodeSessions.set(ctx.from.id, { step: 'ASK_COUNT' });
  ctx.reply("🔢 How many codes would you like to generate? (1-50)");
});

// C. MULTI-STEP TEXT HANDLER
bot.on('text', async (ctx, next) => {
  const session = addCodeSessions.get(ctx.from.id);
  if (!session) return next();

  const input = ctx.message.text.trim();

  switch (session.step) {
    case 'ASK_COUNT':
      const count = parseInt(input);
      if (isNaN(count) || count <= 0 || count > 50) return ctx.reply("❌ Invalid number. Enter 1-50.");
      session.count = count;
      session.step = 'ASK_NAME';
      ctx.reply("📂 Enter the **Resource Name** (Exactly as it appears in React):", { parse_mode: 'Markdown' });
      break;

    case 'ASK_NAME':
      session.name = input;
      session.step = 'ASK_LINK';
      ctx.reply("🔗 Paste the **Download Link** for this resource:");
      break;

    case 'ASK_LINK':
      session.link = input;
      session.step = 'PREVIEW';
      session.codes = Array.from({ length: session.count }, () => generateResourceCode());

      const preview = `📜 *Codes for ${session.name}*\n\n` + 
                      session.codes.map(c => `\`${c}\``).join('\n') + 
                      `\n\n🔗 *Link:* ${session.link}`;
      
      ctx.reply(preview, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Add to DB', 'confirm_add')],
          [Markup.button.callback('🔄 Regenerate', 'regenerate_codes')],
          [Markup.button.callback('❌ Cancel', 'cancel_add')]
        ])
      });
      break;
  }
});

// D. CALLBACK ACTIONS
bot.action('confirm_add', async (ctx) => {
  const session = addCodeSessions.get(ctx.from.id);
  if (!session) return ctx.answerCbQuery("Session Expired.");

  try {
    const batch = db.batch();
    session.codes.forEach(code => {
      const docRef = db.collection('access_codes').doc();
      batch.set(docRef, {
        code: code,
        resourceName: session.name,
        downloadUrl: session.link,
        isUsed: false,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await batch.commit();
    await ctx.editMessageText(`✅ Added ${session.count} codes for *${session.name}* to Firestore.`, { parse_mode: 'Markdown' });
    addCodeSessions.delete(ctx.from.id);
  } catch (e) {
    ctx.reply("❌ Database Error.");
  }
});

bot.action('regenerate_codes', (ctx) => {
  const session = addCodeSessions.get(ctx.from.id);
  if (!session) return ctx.answerCbQuery();

  session.codes = Array.from({ length: session.count }, () => generateResourceCode());
  const preview = `🔄 *Regenerated Codes for ${session.name}*\n\n` + 
                  session.codes.map(c => `\`${c}\``).join('\n');

  ctx.editMessageText(preview, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Add to DB', 'confirm_add')],
      [Markup.button.callback('🔄 Regenerate', 'regenerate_codes')],
      [Markup.button.callback('❌ Cancel', 'cancel_add')]
    ])
  });
});

bot.action('cancel_add', (ctx) => {
  addCodeSessions.delete(ctx.from.id);
  ctx.editMessageText("❌ Cancelled.");
});

// E. HANDLE CONTACT SHARING
bot.on('contact', async (ctx) => {
  const user = ctx.from;
  const contact = ctx.message.contact;

  if (contact.user_id !== user.id) {
    return ctx.reply("⚠️ Error: Please share your own contact.");
  }

  try {
    const pendingDocRef = db.collection('pending_verifications').doc(user.id.toString());
    const pendingDoc = await pendingDocRef.get();

    if (!pendingDoc.exists) {
      return ctx.reply("⚠️ Session expired. Please click 'Verify via Telegram' on the website again.", Markup.removeKeyboard());
    }

    const sessionId = pendingDoc.data().session_id;
    const otp = generateOTP();

    await db.collection('otp_sessions').doc(sessionId).set({
      otp: otp,
      telegram_id: user.id,
      telegram_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      telegram_username: user.username || 'No Username',
      phone_number: contact.phone_number,
      verified: false,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await pendingDocRef.delete();

    await ctx.reply(
      `✅ *Verification Successful*\n\nYour code is:\n\`${otp}\`\n\n(Tap to copy)`,
      { 
        parse_mode: 'Markdown',
        ...Markup.removeKeyboard() 
      }
    );
  } catch (error) {
    console.error("❌ Contact Error:", error);
    ctx.reply("⚠️ Error processing contact. Try again.");
  }
});

// F. HANDLE /admin_socials COMMAND
bot.command('admin_socials', (ctx) => {
  ctx.reply(
    "📞 *Contact Admin*\n\nTap the buttons below to reach out on social media:",
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('WhatsApp', 'https://wa.me/918777845713')], 
        [Markup.button.url('Telegram', 'https://t.me/X_o_x_o_002')]   
      ])
    }
  );
});

// G. HANDLE /info COMMAND
bot.command('info', async (ctx) => {
  try {
    const botInfo = await ctx.telegram.getMe();
    const photos = await ctx.telegram.getUserProfilePhotos(botInfo.id, 0, 1);
    
    let photoSource;
    if (photos.total_count > 0) {
      const lastPhotoArray = photos.photos[0];
      photoSource = lastPhotoArray[lastPhotoArray.length - 1].file_id;
    } else {
      photoSource = 'https://raw.githubusercontent.com/Hawkay002/my-portfolio-bot/main/IMG_20260131_132820_711.jpg';
    }

    const infoMessage = `
<b>🤖 Bot Identity</b>

<blockquote><b>Name:</b> ${botInfo.first_name}
<b>Username:</b> @${botInfo.username}
<b>Bot ID:</b> <code>${botInfo.id}</code></blockquote>


<b>⚙️ Bot Infrastructure</b>

<blockquote><b>👤 Creator:</b> Shovith (Sid)
<b>⏱ Uptime:</b> ${getUptime()} । Uptimerobot.com
<b>🛠 Language:</b> Node.js
<b>📚 Library:</b> Telegraf.js
<b>🔥 Database:</b> Firebase Firestore
<b>☁️ Hosting:</b> Render</blockquote>
<i>© 2026 ${botInfo.first_name}. All rights reserved.</i>
`;

    await ctx.replyWithPhoto(photoSource, {
      caption: infoMessage,
      parse_mode: 'HTML'
    });

  } catch (error) {
    console.error("❌ Info Command Error:", error);
    ctx.reply("⚠️ Could not fetch bot info.");
  }
});

// --- 6. LAUNCH ---
bot.launch();
console.log("🚀 Telegram Bot Started...");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

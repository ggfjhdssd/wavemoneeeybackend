require('dotenv').config();
const crypto = require('crypto');

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const multer     = require('multer');
const { Telegraf } = require('telegraf');
const { message }  = require('telegraf/filters');

// ═══════════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLERS — server crash မဖြစ်အောင်
// ═══════════════════════════════════════════════════════════════
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  UnhandledRejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  UncaughtException:', err.message, err.stack);
  // Don't exit — keep server running
});

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const PORT           = process.env.PORT           || 5000;
const ADMIN_ID       = process.env.ADMIN_CHAT_ID;
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'changeme_admin_secret';
const MIN_WITHDRAW   = Number(process.env.MIN_WITHDRAW)   || 100000;
const SERVICE_FEE    = Number(process.env.SERVICE_FEE)    || 5000;
const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS) || 5000;
const PAYMENT_PHONE  = process.env.PAYMENT_PHONE  || '09783646736';
const PAYMENT_NAME   = process.env.PAYMENT_NAME   || 'Yee Mon Naing';
const BOT_USERNAME   = process.env.BOT_USERNAME   || 'YourBotUsername';
const FRONTEND_URL   = 'https://wavemoneeyfrontend.vercel.app';
// Channel that users must join before using the bot
const CHANNEL_ID     = process.env.CHANNEL_ID    || '@Kbzzpay';   // e.g. @Kbzzpay
const CHANNEL_LINK   = process.env.CHANNEL_LINK  || 'https://t.me/Kbzzpay';

// ═══════════════════════════════════════════════════════════════
//  ASYNC HANDLER WRAPPER — try/catch ထပ်ခါတလဲ မရေးရအောင်
// ═══════════════════════════════════════════════════════════════
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);


// ═══════════════════════════════════════════════════════════════
//  HTML ESCAPE — Telegram HTML parse_mode အတွက်
//  User name မှာ <, >, & ပါနေရင် crash မဖြစ်အောင်
// ═══════════════════════════════════════════════════════════════
const esc = (str) => String(str||'')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;');

// ═══════════════════════════════════════════════════════════════
//  MULTER — Memory storage
// ═══════════════════════════════════════════════════════════════
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const OK = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
    if (OK.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`ပုံဖိုင်သာ တင်ခွင့်ရှိသည် (JPG/PNG/WEBP) — ရရှိသောဖိုင်: ${file.mimetype}`), false);
  },
});

const handleMulterError = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ success: false, message: 'ပုံဖိုင် 10MB ထက်ကြီးနေသည်' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE')
    return res.status(400).json({ success: false, message: `"screenshot" field name သုံးပါ (received: ${err.field})` });
  if (err.message?.includes('ပုံဖိုင်သာ'))
    return res.status(400).json({ success: false, message: err.message });
  next(err);
};

// ═══════════════════════════════════════════════════════════════
//  MONGOOSE MODELS
// ═══════════════════════════════════════════════════════════════

// User — compound indexes for 10,000+ users
const userSchema = new mongoose.Schema({
  telegramId:     { type: String, required: true, unique: true },
  firstName:      { type: String, default: '' },
  lastName:       { type: String, default: '' },
  username:       { type: String, default: '' },
  balance:        { type: Number, default: 0, min: 0 },
  totalEarned:    { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  referrals:      { type: Number, default: 0 },
  referredBy:     { type: String, default: null },
  referralCode:   { type: String, unique: true, sparse: true },
  isBanned:       { type: Boolean, default: false },
  isBlocked:      { type: Boolean, default: false }, // bot blocked by user
  banReason:      { type: String, default: '' },
  isAdmin:        { type: Boolean, default: false },
  lastSeen:       { type: Date, default: Date.now },
  lastBonusClaim: { type: Number, default: 0 }, // unix ms — for 2hr cooldown
}, { timestamps: true });

// Optimized indexes
// telegramId index already defined via unique:true in schema
userSchema.index({ referralCode: 1 }, { sparse: true });
userSchema.index({ isBanned: 1 });
userSchema.index({ referrals: -1, totalEarned: -1 }); // leaderboard query
userSchema.index({ isBlocked: 1 });                    // broadcast filter

userSchema.virtual('displayName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ')
    || this.username || `User ${this.telegramId}`;
});
userSchema.set('toJSON', { virtuals: true });
const User = mongoose.model('User', userSchema);

// Withdrawal — TTL index: rejected records auto-delete after 3 days (259200 seconds)
const withdrawalSchema = new mongoose.Schema({
  user:                { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId:          { type: String, required: true },
  amount:              { type: Number, required: true },
  fee:                 { type: Number, default: 5000 },
  netAmount:           { type: Number, required: true },
  userKpayPhone:       { type: String, default: '' },
  userKpayName:        { type: String, default: '' },
  telegramPhotoFileId: { type: String, default: '' },
  status:              { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  rejectionReason:     { type: String, default: '' },
  adminNote:           { type: String, default: '' },
  reviewedAt:          { type: Date },
  deletedAt:           { type: Date, default: null }, // set when rejected → TTL triggers
}, { timestamps: true });

withdrawalSchema.index({ telegramId: 1 });
withdrawalSchema.index({ status: 1 });
// TTL: auto-delete 3 days (259200s) after deletedAt is set
withdrawalSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 259200, sparse: true });

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// SupportMessage — TTL: auto-delete after 3 days
const supportSchema = new mongoose.Schema({
  telegramId:  { type: String, required: true },
  displayName: { type: String, default: '' },
  text:        { type: String, required: true },
  direction:   { type: String, enum: ['user_to_admin','admin_to_user'], required: true },
  isRead:      { type: Boolean, default: false },
}, { timestamps: true });
supportSchema.index({ telegramId: 1 });
// TTL: documents expire 3 days (259200s) after createdAt
supportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 259200 });
const SupportMsg = mongoose.model('SupportMessage', supportSchema);

// BotMessage — tracks all Telegram message_ids sent to/from users so we can delete them
// Stores both messages the bot sent TO the user, and messages the user sent to the bot
const botMessageSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true }, // the user's chat ID
  messageId:  { type: Number, required: true },              // Telegram message_id
}, { timestamps: true });
botMessageSchema.index({ telegramId: 1, messageId: 1 }, { unique: true });
// TTL: auto-delete tracking records 7 days after creation (Telegram can only delete ≤48hr old messages anyway)
botMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
const BotMessage = mongoose.model('BotMessage', botMessageSchema);

// PaymentConfig
const paymentConfigSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  phone: { type: String, default: '09783646736' },
  name:  { type: String, default: 'Yee Mon Naing' },
}, { timestamps: true });
const PaymentConfig = mongoose.model('PaymentConfig', paymentConfigSchema);

// ═══════════════════════════════════════════════════════════════
//  EXPRESS APP
// ═══════════════════════════════════════════════════════════════
const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  FRONTEND_URL,
  'https://wavepay.vercel.app',
  'https://wavemoneeyfrontend.vercel.app',
  'https://wavemoneeeybackend.onrender.com',
  'http://localhost:3000',
  'http://localhost:5000',
];
const corsOpts = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-telegram-id','x-init-data','X-Telegram-Init-Data','x-admin-secret','Authorization'],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));
app.use(rateLimit({ windowMs: 60000, max: 90, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests' } }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Helper: parse user ID from Telegram initData string ─────────────────────
function parseTidFromInitData(initDataStr) {
  try {
    if (!initDataStr) return null;
    const params  = new URLSearchParams(initDataStr);
    const userStr = params.get('user');
    if (!userStr) return null;
    const u = JSON.parse(userStr);
    return u?.id ? String(u.id) : null;
  } catch { return null; }
}

// ── Helper: get tid from request ─────────────────────────────────────────────
function getTidFromReq(req) {
  // 1. x-telegram-id header
  const hTid = (req.headers['x-telegram-id'] || '').trim();
  if (hTid && hTid !== 'demo' && hTid !== 'null' && hTid !== 'undefined') return hTid;

  // 2. telegramId from request body (POST requests)
  const bTid = String(req.body?.telegramId || '').trim();
  if (bTid && bTid !== 'demo' && bTid !== 'null' && bTid !== 'undefined') return bTid;

  // 3. Parse from initData header
  const initData = req.headers['x-telegram-init-data'] || req.headers['x-init-data'] || '';
  if (initData) {
    const parsed = parseTidFromInitData(initData);
    if (parsed) return parsed;
  }
  return null;
}

// ── Middleware ──────────────────────────────────────────────────────────────────
const requireUser = asyncHandler(async (req, res, next) => {
  const tid = getTidFromReq(req);
  if (!tid) return res.status(401).json({ success: false, message: 'Telegram ID မရှိပါ — Bot မှ App ဖွင့်ပါ' });
  const u = await User.findOne({ telegramId: tid });
  if (!u) return res.status(404).json({ success: false, message: 'User not found. Please start the bot first.' });
  if (u.isBanned) return res.status(403).json({ success: false, message: `🚫 Account banned: ${esc(u.banReason)}` });
  req.user = u; next();
});

const requireAdmin = (req, res, next) => {
  const s = req.headers['x-admin-secret'];
  if (!s || s !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Forbidden' });
  next();
};

// ── Bot send helpers (Telegram block/403 handling) ────────────────────────────
let bot = null; // declared early so helpers can reference it

const sendTg = async (chatId, text, extra = {}) => {
  if (!bot) return null;
  try {
    const msg = await bot.telegram.sendMessage(String(chatId), text, { parse_mode: 'HTML', ...extra });
    // Track message_id so /delete can wipe the chat later
    if (msg?.message_id) {
      BotMessage.create({ telegramId: String(chatId), messageId: msg.message_id }).catch(() => {});
    }
    return msg;
  } catch (e) {
    if (e.response?.error_code === 403 || e.message?.includes('bot was blocked')) {
      console.warn(`sendTg: user ${chatId} blocked bot — marking isBlocked`);
      await User.findOneAndUpdate({ telegramId: String(chatId) }, { isBlocked: true }).catch(() => {});
    } else {
      console.warn(`sendTg(${chatId}) failed:`, e.message);
    }
    return null;
  }
};

const sendTgPhoto = async (chatId, buffer, filename, caption, extra = {}) => {
  if (!bot) return null;
  try {
    const msg = await bot.telegram.sendPhoto(String(chatId),
      { source: buffer, filename: filename || 'screenshot.jpg' },
      { caption, parse_mode: 'HTML', ...extra }
    );
    // Track message_id
    if (msg?.message_id) {
      BotMessage.create({ telegramId: String(chatId), messageId: msg.message_id }).catch(() => {});
    }
    return msg;
  } catch (e) {
    if (e.response?.error_code === 403 || e.message?.includes('bot was blocked')) {
      console.warn(`sendTgPhoto: user ${chatId} blocked bot — marking isBlocked`);
      await User.findOneAndUpdate({ telegramId: String(chatId) }, { isBlocked: true }).catch(() => {});
    } else {
      console.warn(`sendTgPhoto(${chatId}) failed:`, e.message);
    }
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Wave Pay Backend', time: new Date().toISOString() }));

// Config — reads from DB (admin can update via /setpayment bot command)
app.get('/api/config', asyncHandler(async (_req, res) => {
  const cfg = await PaymentConfig.findOne({ key: 'payment' }).catch(() => null);
  res.json({
    success: true,
    data: {
      paymentPhone:  cfg?.phone || PAYMENT_PHONE,
      paymentName:   cfg?.name  || PAYMENT_NAME,
      minWithdraw:   MIN_WITHDRAW,
      serviceFee:    SERVICE_FEE,
      referralBonus: REFERRAL_BONUS,
    },
  });
}));

// Ad reward — no requireUser, upsert if user not found
app.post('/api/ad-reward', asyncHandler(async (req, res) => {
  const rawHeader = req.headers['x-telegram-id'] || '';
  const tid = getTidFromReq(req);
  console.log(`[ad-reward] raw header: "${rawHeader}" → resolved tid: "${tid}"`);
  if (!tid) {
    console.warn('[ad-reward] FAILED - no valid tid');
    return res.status(400).json({ success: false, message: 'Telegram ID မရှိပါ — Bot မှ App ဖွင့်ပါ' });
  }

  const reward = parseInt(req.body.amount) || 3000;
  if (reward <= 0 || reward > 10000)
    return res.status(400).json({ success: false, message: 'Invalid reward amount' });

  // findOneAndUpdate + upsert — user မရှိသေးရင်လည်း auto create ဖြစ်မည်
  const updated = await User.findOneAndUpdate(
    { telegramId: tid },
    {
      $inc: { balance: reward, totalEarned: reward },
      $setOnInsert: { telegramId: tid, referralCode: `ref_${tid}` },
    },
    { new: true, upsert: true }
  );

  console.log(`[ad-reward] +${reward} Ks → ${tid} (balance: ${updated.balance})`);
  res.json({ success: true, data: { newBalance: updated.balance } });
}));

// ── Claim Bonus — 2-hour cooldown, stored in DB ──────────────────────────────
app.post('/api/claim-bonus', asyncHandler(async (req, res) => {
  const tid = getTidFromReq(req);
  console.log(`[claim-bonus] tid=${tid} header=${req.headers['x-telegram-id']} body=${req.body?.telegramId}`);
  if (!tid) {
    return res.status(400).json({ success: false, message: 'Telegram ID မရှိပါ — Bot မှ App ဖွင့်ပါ' });
  }

  const BONUS    = 3000;
  const COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours in ms
  const now      = Date.now();

  // Find or create user
  let user = await User.findOne({ telegramId: tid });
  if (!user) {
    user = await User.create({ telegramId: tid, referralCode: `ref_${tid}` });
  }

  // Check cooldown
  const lastClaim = user.lastBonusClaim || 0;
  const elapsed   = now - lastClaim;
  if (elapsed < COOLDOWN) {
    const remainingSecs = Math.ceil((COOLDOWN - elapsed) / 1000);
    return res.status(429).json({
      success: false,
      message: `${Math.ceil(remainingSecs/3600)} နာရီနောက်မှ ထပ်ယူနိုင်သည်`,
      cooldownSeconds: remainingSecs,
    });
  }

  // Grant bonus
  const updated = await User.findOneAndUpdate(
    { telegramId: tid },
    { $inc: { balance: BONUS, totalEarned: BONUS }, $set: { lastBonusClaim: now } },
    { new: true }
  );

  console.log(`[claim-bonus] +${BONUS} Ks → ${tid} (balance: ${updated.balance})`);
  res.json({ success: true, data: { newBalance: updated.balance, reward: BONUS } });
}));

// User init/login — Fixed Referral Logic (ref_ prefix optional, self-referral blocked)
app.post('/api/users/me', asyncHandler(async (req, res) => {
  let { telegramId, firstName, lastName, username, referralCode } = req.body;
  if (!telegramId) return res.status(400).json({ success: false, message: 'telegramId required' });

  let user = await User.findOne({ telegramId });

  if (!user) {
    const myCode = `ref_${telegramId}`;

    // Create user first
    user = new User({ telegramId, firstName, lastName, username, referralCode: myCode });

    // Process referral if provided
    if (referralCode) {
      // Handle both "ref_12345" and "12345" formats
      const cleanRefId = referralCode.replace('ref_', '');

      // Block self-referral
      if (cleanRefId !== String(telegramId)) {
        const referrer = await User.findOne({ telegramId: cleanRefId });

        if (referrer && !referrer.isBanned) {
          // Credit referrer
          await User.findByIdAndUpdate(referrer._id, {
            $inc: { balance: REFERRAL_BONUS, totalEarned: REFERRAL_BONUS, referrals: 1 },
          });

          // Save who referred this user
          user.referredBy = cleanRefId;

          // Notify referrer
          await sendTg(cleanRefId,
            `🎉 <b>မိတ်ဆွေသစ် တစ်ယောက် ရောက်လာပါပြီ!</b>\n\n` +
            `လူကြီးမင်း၏ Link မှတစ်ဆင့် ဝင်ရောက်လာသောကြောင့် Referral Bonus ` +
            `<b>${REFERRAL_BONUS.toLocaleString()} Ks</b> ထည့်ပေးပြီးပါပြီ။`
          );
        }
      }
    }

    await user.save();

  } else {
    // Update existing user
    await User.findByIdAndUpdate(user._id, {
      firstName: firstName || user.firstName,
      lastName:  lastName  || user.lastName,
      username:  username  || user.username,
      lastSeen:  new Date(),
      isBlocked: false,
    });
    user = await User.findById(user._id);
  }

  if (user.isBanned)
    return res.status(403).json({ success: false, message: `🚫 Account banned: ${esc(user.banReason)}` });

  return res.json({
    success: true,
    data: {
      telegramId:     user.telegramId,
      displayName:    user.displayName,
      firstName:      user.firstName,
      username:       user.username,
      balance:        user.balance,
      referrals:      user.referrals,
      totalEarned:    user.totalEarned,
      totalWithdrawn: user.totalWithdrawn,
      referralCode:   user.referralCode,
      referralLink:   `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`,
      isAdmin:        user.isAdmin,
    },
  });
}));

// Leaderboard
app.get('/api/users/leaderboard', asyncHandler(async (_req, res) => {
  const users = await User.find({ isBanned: false })
    .sort({ referrals: -1, totalEarned: -1 }).limit(20)
    .select('telegramId firstName lastName username referrals totalEarned');
  res.json({ success: true, data: users.map((u, i) => ({
    rank: i + 1, name: u.displayName,
    avatar: u.displayName.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase(),
    referrals: u.referrals, earned: u.totalEarned,
  }))});
}));

// ── WITHDRAWAL SUBMIT ──────────────────────────────────────────────────────────
app.post('/api/withdrawals',
  requireUser,
  (req, res, next) => { upload.single('screenshot')(req, res, err => { if (err) return handleMulterError(err, req, res, next); next(); }); },
  asyncHandler(async (req, res) => {
    let balanceDeducted = false, deductAmount = 0;
    const user = req.user;

    try {
      const rawAmount = req.body?.amount;
      const amount    = parseInt(rawAmount, 10);
      const uKpayPhone = (req.body?.userKpayPhone || '').trim();
      const uKpayName  = (req.body?.userKpayName  || '').trim();

      if (!req.file?.buffer)
        return res.status(400).json({ success: false, message: 'Screenshot ပုံတင်ရန် လိုအပ်သည်' });
      if (!rawAmount || isNaN(amount) || amount < MIN_WITHDRAW)
        return res.status(400).json({ success: false, message: `အနည်းဆုံး ${MIN_WITHDRAW.toLocaleString()} Ks ဖြစ်ရမည်` });

      // Balance check: only need `amount` (fee paid externally)
      if (user.balance < amount)
        return res.status(400).json({ success: false, message: `လက်ကျန်ငွေ မလုံလောက်ပါ (${amount.toLocaleString()} Ks လိုသည်)` });

      const hasPending = await Withdrawal.findOne({ telegramId: user.telegramId, status: 'pending' });
      if (hasPending)
        return res.status(409).json({ success: false, message: 'ကြိုတင်တင်ထားသော ငွေထုတ်မှု ရှိနေသေးပါသည်' });

      // Deduct only withdrawal amount
      deductAmount = amount;
      const newBalance = user.balance - amount;
      await User.findByIdAndUpdate(user._id, { $inc: { balance: -amount } });
      balanceDeducted = true;

      // Save record
      let wd;
      try {
        wd = await Withdrawal.create({
          user: user._id, telegramId: user.telegramId,
          amount, fee: SERVICE_FEE, netAmount: amount - SERVICE_FEE,
          userKpayPhone: uKpayPhone, userKpayName: uKpayName,
        });
      } catch (dbErr) {
        await User.findByIdAndUpdate(user._id, { $inc: { balance: amount } }).catch(() => {});
        return res.status(500).json({ success: false, message: 'မှတ်တမ်းသိမ်းရာတွင် error — balance ပြန်ထည့်ပေးပြီးပါပြီ' });
      }

      // Notify admin via photo
      if (ADMIN_ID && bot) {
        const caption =
          `💸 <b>ငွေထုတ်ယူမှု တောင်းဆိုမှု</b>\n\n` +
          `👤 <b>နာမည်:</b> ${esc(user.displayName)}\n` +
          `🔖 <b>Username:</b> @${user.username || 'N/A'}\n` +
          `🆔 <b>Telegram ID:</b> <code>${user.telegramId}</code>\n` +
          `💰 <b>ထုတ်ယူမည့်ငွေ:</b> ${amount.toLocaleString()} Ks\n` +
          (uKpayPhone ? `💳 <b>User KPay:</b> ${uKpayPhone} (${uKpayName || 'N/A'})\n` : '') +
          `📅 ${new Date().toLocaleString()}`;

        const photoMsg = await sendTgPhoto(ADMIN_ID, req.file.buffer,
          req.file.originalname || 'screenshot.jpg', caption,
          { reply_markup: { inline_keyboard: [[
            { text: '✅ Approve', callback_data: `wd_approve_${wd._id}` },
            { text: '❌ Reject',  callback_data: `wd_reject_${wd._id}`  },
          ]]}});

        if (photoMsg?.photo) {
          const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
          await Withdrawal.findByIdAndUpdate(wd._id, { telegramPhotoFileId: fileId }).catch(() => {});
        }
      }

      // Notify user — withdrawal submitted confirmation
      await sendTg(user.telegramId,
        `💸 <b>ငွေထုတ်ယူမှု တင်ပြီးပါပြီ</b>\n\n` +
        `💰 <b>ထုတ်ယူလိုသော ပမာဏ:</b> ${amount.toLocaleString()} ကျပ်\n` +
        `💳 <b>လက်ခံမည့်အကောင့်:</b> ${uKpayPhone || '0' + '9*'.padEnd(8,'*')} (KPay)\n` +
        `⏳ <b>အခြေအနေ:</b> စနစ်မှ စစ်ဆေးနေဆဲ (Processing...)\n\n` +
        `ကျွန်ုပ်တို့၏ Pay to Pay စနစ်သည် ငွေကြေးလုံခြုံမှုအတွက် အဆင့်ဆင့် စစ်ဆေးနေရသဖြင့် ` +
        `<b>၅ မိနစ်မှ ၁၅ မိနစ်အတွင်း</b> လူကြီးမင်း၏ Wallet ထဲသို့ ငွေများ အလိုအလျောက် ` +
        `ရောက်ရှိလာပါလိမ့်မည်။ ခေတ္တခဏ စောင့်ဆိုင်းပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။`
      );

      return res.status(201).json({
        success: true,
        message: 'ငွေထုတ်ယူမှု တင်ပြီးပါပြီ။ Admin မှ စစ်ဆေးပြီးနောက် Telegram မှ အကြောင်းကြားပါမည်။',
        data: { id: wd._id, amount: wd.amount, fee: wd.fee, netAmount: wd.netAmount, status: wd.status, newBalance },
      });

    } catch (err) {
      console.error('Withdrawal error:', err.message);
      if (balanceDeducted)
        await User.findByIdAndUpdate(user._id, { $inc: { balance: deductAmount } }).catch(() => {});
      return res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
  })
);

// ── P2P SUBMIT ─────────────────────────────────────────────────────────────────
app.post('/api/p2p',
  (req, res, next) => { upload.single('screenshot')(req, res, err => { if (err) return handleMulterError(err, req, res, next); next(); }); },
  asyncHandler(async (req, res) => {
    const tid = req.headers['x-telegram-id'];
    const user = tid ? await User.findOne({ telegramId: tid }).catch(() => null) : null;
    const displayName = user?.displayName || (tid ? `User ${tid}` : 'Unknown');
    const username    = user?.username || 'N/A';
    const telegramId  = tid || 'N/A';
    const uKpayPhone  = (req.body?.userKpayPhone || '').trim();
    const uKpayName   = (req.body?.userKpayName  || '').trim();

    const rawAmount = req.body?.amount;
    const amount    = parseInt(rawAmount, 10);

    if (!req.file?.buffer)
      return res.status(400).json({ success: false, message: 'Screenshot ပုံတင်ရန် လိုအပ်သည်' });
    if (!rawAmount || isNaN(amount) || amount < 20000)
      return res.status(400).json({ success: false, message: 'အနည်းဆုံး 20,000 Ks ဖြစ်ရမည်' });

    if (ADMIN_ID && bot) {
      const caption =
        `💹 <b>Pay to Pay တောင်းဆိုမှု</b>\n\n` +
        `👤 <b>နာမည်:</b> ${displayName}\n` +
        `🔖 <b>Username:</b> @${username}\n` +
        `🆔 <b>Telegram ID:</b> <code>${telegramId}</code>\n` +
        `💰 <b>ဝယ်ယူပမာဏ:</b> ${amount.toLocaleString()} Ks\n` +
        `💵 <b>ပြန်ပေးရမည်:</b> ${(amount * 5).toLocaleString()} Ks (x5)\n` +
        (uKpayPhone ? `💳 <b>User KPay:</b> ${uKpayPhone} (${uKpayName || 'N/A'})\n` : '') +
        `📅 ${new Date().toLocaleString()}`;
      await sendTgPhoto(ADMIN_ID, req.file.buffer, req.file.originalname || 'p2p_screenshot.jpg', caption);
    }

    return res.status(201).json({
      success: true,
      message: 'တင်ပြီးပါပြီ။ Admin မှ စစ်ဆေးပြီးနောက် Telegram မှ အကြောင်းကြားပါမည်။',
    });
  })
);

app.get('/api/withdrawals/mine', requireUser, asyncHandler(async (req, res) => {
  const wds = await Withdrawal.find({ telegramId: req.user.telegramId }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data: wds });
}));

app.get('/api/withdrawals/recent', asyncHandler(async (_req, res) => {
  const wds = await Withdrawal.find({ status: 'approved' }).sort({ updatedAt: -1 }).limit(20)
    .populate('user','firstName lastName username');
  res.json({ success: true, data: wds.map(w => ({
    id: w._id, name: w.user?.displayName || 'User',
    avatar: (w.user?.displayName||'U').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(),
    net: w.netAmount, date: w.updatedAt.toISOString().split('T')[0],
  }))});
}));

// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const [total, banned, blocked, pending, approved, rejected, balRes] = await Promise.all([
    User.countDocuments(), User.countDocuments({ isBanned: true }),
    User.countDocuments({ isBlocked: true }),
    Withdrawal.countDocuments({ status: 'pending' }),
    Withdrawal.countDocuments({ status: 'approved' }),
    Withdrawal.countDocuments({ status: 'rejected' }),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]),
  ]);
  res.json({ success: true, data: { total, banned, blocked, withdrawals: { pending, approved, rejected }, totalBalance: balRes[0]?.total || 0 } });
}));

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const { page=1, limit=30, search, banned } = req.query;
  const f = {};
  if (search) f.$or = [{ firstName: new RegExp(search,'i') },{ username: new RegExp(search,'i') },{ telegramId: search }];
  if (banned !== undefined) f.isBanned = banned === 'true';
  const [users, count] = await Promise.all([
    User.find(f).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit)),
    User.countDocuments(f),
  ]);
  res.json({ success: true, data: users, total: count });
}));

adminRouter.post('/users/:tid/ban', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const u = await User.findOneAndUpdate({ telegramId: req.params.tid },
    { isBanned: true, banReason: reason||'Violated terms' }, { new: true });
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  await sendTg(u.telegramId, `🚫 <b>Account ပိတ်ထားပါသည်</b>\nအကြောင်း: ${reason||'Violated terms'}`);
  res.json({ success: true, data: u });
}));

adminRouter.post('/users/:tid/unban', asyncHandler(async (req, res) => {
  const u = await User.findOneAndUpdate({ telegramId: req.params.tid },
    { isBanned: false, banReason: '' }, { new: true });
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  await sendTg(u.telegramId, `✅ <b>Account ပြန်ဖွင့်ပေးပြီးပါပြီ</b>`);
  res.json({ success: true, data: u });
}));

adminRouter.patch('/users/:tid/balance', asyncHandler(async (req, res) => {
  const { action, amount, note } = req.body;
  if (!['add','subtract'].includes(action))
    return res.status(400).json({ success: false, message: 'action: add|subtract' });
  const u = await User.findOne({ telegramId: req.params.tid });
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  const delta = action === 'add' ? Math.abs(amount) : -Math.abs(amount);
  if (action === 'subtract' && u.balance < Math.abs(amount))
    return res.status(400).json({ success: false, message: 'Insufficient balance' });
  const inc = { balance: delta }; if (action === 'add') inc.totalEarned = Math.abs(amount);
  const updated = await User.findByIdAndUpdate(u._id, { $inc: inc }, { new: true });
  await sendTg(u.telegramId, `💰 <b>Admin မှ ${Math.abs(amount).toLocaleString()} Ks ${action==='add'?'ထည့်':'နုတ်'}ပေးပါပြီ</b>\nလက်ကျန်: ${updated.balance.toLocaleString()} Ks${note?`\nမှတ်ချက်: ${note}`:''}`);
  res.json({ success: true, data: updated });
}));

adminRouter.patch('/users/:tid/referrals', asyncHandler(async (req, res) => {
  const { count } = req.body;
  const bonus = count * REFERRAL_BONUS;
  const u = await User.findOneAndUpdate({ telegramId: req.params.tid },
    { $inc: { referrals: count, balance: bonus, totalEarned: bonus } }, { new: true });
  if (!u) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, data: u });
}));

adminRouter.get('/withdrawals', asyncHandler(async (req, res) => {
  const { status, page=1, limit=20 } = req.query;
  const f = {}; if (status) f.status = status;
  const [wds, total] = await Promise.all([
    Withdrawal.find(f).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit))
      .populate('user','firstName lastName username telegramId'),
    Withdrawal.countDocuments(f),
  ]);
  res.json({ success: true, data: wds, total });
}));

adminRouter.post('/withdrawals/:id/approve', asyncHandler(async (req, res) => {
  const wd = await Withdrawal.findById(req.params.id).populate('user');
  if (!wd) return res.status(404).json({ success: false, message: 'Not found' });
  if (wd.status !== 'pending') return res.status(409).json({ success: false, message: 'Already processed' });
  wd.status = 'approved'; wd.reviewedAt = new Date(); wd.adminNote = req.body.note || '';
  await wd.save();
  await User.findByIdAndUpdate(wd.user._id, { $inc: { totalWithdrawn: wd.netAmount } });
  await sendTg(wd.telegramId, `✅ <b>ငွေထုတ်ယူမှု အတည်ပြုပြီးပါပြီ!</b>\n💰 ${wd.netAmount.toLocaleString()} Ks ကို မကြာမီ ပေးပို့ပါမည်`);
  res.json({ success: true, data: wd });
}));

adminRouter.post('/withdrawals/:id/reject', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ success: false, message: 'reason required' });
  const wd = await Withdrawal.findById(req.params.id).populate('user');
  if (!wd) return res.status(404).json({ success: false, message: 'Not found' });
  if (wd.status !== 'pending') return res.status(409).json({ success: false, message: 'Already processed' });
  wd.status = 'rejected'; wd.rejectionReason = reason; wd.reviewedAt = new Date();
  wd.deletedAt = new Date(); // triggers TTL → auto-delete after 3 days
  await wd.save();
  await User.findByIdAndUpdate(wd.user._id, { $inc: { balance: wd.amount + wd.fee } });
  await sendTg(wd.telegramId,
    `❌ <b>ငွေထုတ်ယူမှု ငြင်းပယ်ပါသည်</b>\n\nအကြောင်းပြချက်: ${reason}\n\n💰 ${(wd.amount+wd.fee).toLocaleString()} Ks ပြန်ထည့်ပေးပြီးပါပြီ`
  );
  res.json({ success: true, data: wd });
}));

// Admin: get/set payment config
adminRouter.get('/payment-config', asyncHandler(async (_req, res) => {
  const cfg = await PaymentConfig.findOne({ key: 'payment' });
  res.json({ success: true, data: cfg || { phone: PAYMENT_PHONE, name: PAYMENT_NAME } });
}));

adminRouter.post('/payment-config', asyncHandler(async (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !name) return res.status(400).json({ success: false, message: 'phone and name required' });
  const cfg = await PaymentConfig.findOneAndUpdate(
    { key: 'payment' }, { phone: phone.trim(), name: name.trim() },
    { upsert: true, new: true }
  );
  res.json({ success: true, data: cfg, message: 'Payment config updated' });
}));

adminRouter.post('/broadcast', asyncHandler(async (req, res) => {
  const { message: msg } = req.body;
  if (!msg) return res.status(400).json({ success: false, message: 'message required' });
  // Only send to non-blocked, non-banned users
  const users = await User.find({ isBanned: false, isBlocked: false }).select('telegramId');
  let sent = 0, failed = 0, blocked = 0;
  // Rate limit: 20 messages/second (Telegram allows 30/sec, use 20 to be safe)
  const BATCH = 20;
  for (let i = 0; i < users.length; i++) {
    const ok = await sendTg(users[i].telegramId, `📢 <b>ကြေညာချက်</b>\n\n${msg}`);
    if (ok) { sent++; }
    else { failed++; }
    // Every BATCH messages, wait 1 second
    if ((i + 1) % BATCH === 0) await new Promise(r => setTimeout(r, 1000));
  }
  res.json({ success: true, data: { sent, failed, blocked, total: users.length } });
}));

app.use('/api/admin', adminRouter);
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error('Global error:', err.code||'', err.message);
  if (err.code === 'LIMIT_FILE_SIZE')       return res.status(400).json({ success: false, message: 'ပုံဖိုင် 10MB ထက်ကြီးနေသည်' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ success: false, message: '"screenshot" field name သုံးပါ' });
  if (err.message?.startsWith('CORS'))      return res.status(403).json({ success: false, message: err.message });
  if (err.name === 'ValidationError')       return res.status(400).json({ success: false, message: err.message });
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════
//  TELEGRAF BOT
// ═══════════════════════════════════════════════════════════════
function initBot() {
  if (!process.env.BOT_TOKEN) { console.warn('⚠️  BOT_TOKEN not set — bot disabled'); return; }
  bot = new Telegraf(process.env.BOT_TOKEN);

  const pendingReplies    = {};
  const pendingRejections = {};

  // ── Helper: check if user has joined the channel ─────────────────────────────
  async function isChannelMember(userId) {
    try {
      const member = await bot.telegram.getChatMember(CHANNEL_ID, Number(userId));
      return ['member','administrator','creator'].includes(member.status);
    } catch {
      return false; // If can't check, assume not member
    }
  }

  // ── Send channel join prompt (referral code ပါ encode လုပ်ထားသည်) ─────────────
  async function sendJoinPrompt(ctx, refCode = '') {
    // callback_data: "check_join_{userId}_{refCode}" — refCode မပါက empty string
    const cbData = refCode
      ? `check_join_${ctx.from.id}_${refCode}`
      : `check_join_${ctx.from.id}_`;
    await ctx.reply(
      `👋 မင်္ဂလာပါ ${esc(ctx.from.first_name)}!\n\n` +
      `⚠️ <b>Bot ကို အသုံးပြုရန် ကျွန်ုပ်တို့၏ Channel ကို အရင် Join ပါ။</b>\n\n` +
      `📢 Channel Join ပြီးမှ <b>Joined ✅</b> ကိုနှိပ်ပါ။`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '📢 Channel Join မည်', url: CHANNEL_LINK },
          ],[
            { text: 'Joined ✅', callback_data: cbData },
          ]],
        },
      }
    );
  }

  // /start
  bot.start(async ctx => {
    const tgUser    = ctx.from;
    const chatId    = String(ctx.chat.id);
    const startParam = ctx.startPayload || '';

    try {
      // Admin bypasses channel check
      if (chatId !== ADMIN_ID) {
        const joined = await isChannelMember(chatId);
        if (!joined) {
          // Pass referral code so it survives the channel join step
          return sendJoinPrompt(ctx, startParam);
        }
      }

      // Channel joined — proceed with registration
      let user = await User.findOne({ telegramId: chatId });
      if (!user) {
        const myCode = `ref_${chatId}`;
        user = await User.create({
          telegramId: chatId, firstName: tgUser.first_name||'',
          lastName: tgUser.last_name||'', username: tgUser.username||'',
          referralCode: myCode,
        });
        if (startParam) {
          // Handle both "ref_12345" and "12345" formats
          const cleanRefId = startParam.replace('ref_', '');

          // Block self-referral
          if (cleanRefId !== chatId) {
            const referrer = await User.findOne({ telegramId: cleanRefId });
            if (referrer && !referrer.isBanned) {
              await User.findByIdAndUpdate(referrer._id, {
                $inc: { balance: REFERRAL_BONUS, totalEarned: REFERRAL_BONUS, referrals: 1 },
              });
              user.referredBy = cleanRefId; await user.save();
              await sendTg(cleanRefId,
                `🎉 <b>မိတ်ဆွေသစ် တစ်ယောက် ရောက်လာပါပြီ!</b>\n\n` +
                `လူကြီးမင်း၏ Link မှတစ်ဆင့် ဝင်ရောက်လာသောကြောင့် Referral Bonus ` +
                `<b>${REFERRAL_BONUS.toLocaleString()} Ks</b> ထည့်ပေးပြီးပါပြီ။`
              );
            }
          }
        }
      } else {
        await User.findByIdAndUpdate(user._id, {
          firstName: tgUser.first_name||user.firstName,
          lastName:  tgUser.last_name ||user.lastName,
          username:  tgUser.username  ||user.username,
          lastSeen:  new Date(), isBlocked: false,
        });
      }

      if (user.isBanned) return ctx.reply(`🚫 Account ပိတ်ထားပါသည်\nအကြောင်း: ${esc(user.banReason)}`);

      const startReply = await ctx.reply(
        `👋 မင်္ဂလာပါ ${esc(tgUser.first_name)}\n` +
        `KBZPay Mini App မှ ကြိုဆိုပါသည် 🎉\n\n` +
        `💰 ယခုပဲ <b>💰 App ဖွင့်မည်</b> ကိုနှိပ်ပြီး ပိုက်ဆံများ စတင်ရှာဖွေလိုက်ပါ။\n\n` +
        `👥 အထူးအစီအစဉ်အနေဖြင့် မိမိ၏ သူငယ်ချင်းများကို ဖိတ်ခေါ်ပြီး တစ်ယောက်လျှင် ` +
        `<b>၅,၀၀၀ ကျပ်</b> စီ အခမဲ့ ရယူကာ ပိုက်ဆံများ အမြန်ဆုံး ထုတ်ယူနိုင်ပါပြီ။`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '💰 App ဖွင့်မည်', web_app: { url: FRONTEND_URL } },
          ]]},
        }
      );
      // Track this bot reply so /delete can wipe it later
      if (startReply?.message_id) {
        BotMessage.create({ telegramId: chatId, messageId: startReply.message_id }).catch(() => {});
      }
      // Also track the user's /start message itself
      if (ctx.message?.message_id) {
        BotMessage.create({ telegramId: chatId, messageId: ctx.message.message_id }).catch(() => {});
      }
    } catch (e) { console.error('Bot /start error:', e.message); }
  });

  // ── Admin slash commands ──────────────────────────────────────────────────────
  bot.command('admin', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    ctx.reply(
      `🛠 <b>Admin Commands</b>\n\n` +
      `<b>── User Management ──</b>\n` +
      `/ban [id] [reason] — User ban လုပ်ရန်\n` +
      `/unban [id] — User ban ဖြုတ်ရန်\n` +
      `/userinfo [id] — User အချက်အလက်\n` +
      `/addmoney [id] [amount] — Balance ထည့်\n` +
      `/reducemoney [id] [amount] — Balance နုတ်\n` +
      `/addrefs [id] [count] — Referral တိုး\n\n` +
      `<b>── Messaging ──</b>\n` +
      `/msg [id] [text] — User တစ်ယောက်ဆီ direct message\n` +
      `/broadcast [text] — Users အားလုံးဆီ message\n\n` +
      `<b>── Statistics ──</b>\n` +
      `/stats — App အချက်အလက် အကျဉ်း\n` +
      `/listusers [page] — User list ကြည့်ရန် (1 page = 10)\n` +
      `/topusers — Top 10 ဆုံးဖြတ်သူများ\n` +
      `/richusers — Balance အများဆုံး user ၁၀ ယောက်\n` +
      `/delete [id] — User နဲ့ data အားလုံး ဖျက်ရန်\n\n` +
      `<b>── Config ──</b>\n` +
      `/setpayment [phone] [name] — KPay နံပါတ်/နာမည် ပြောင်း`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /setpayment ───────────────────────────────────────────────────────────────
  bot.command('setpayment', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.reply('Usage: /setpayment [phone] [name]\nExample: /setpayment 09702310926 Daw Mi Thaung');
    const phone = parts[1], name = parts.slice(2).join(' ');
    try {
      await PaymentConfig.findOneAndUpdate({ key: 'payment' }, { phone: phone.trim(), name: name.trim() }, { upsert: true, new: true });
      ctx.reply(`✅ <b>Payment Config ပြောင်းပြီးပါပြီ</b>\n\n📱 <b>ဖုန်းနံပါတ်:</b> ${phone}\n👤 <b>နာမည်:</b> ${name}\n\nFrontend မှ ချက်ချင်း အသစ်ဖြစ်မည်`, { parse_mode: 'HTML' });
    } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
  });

  // ── /msg — Admin to specific User ─────────────────────────────────────────────
  bot.command('msg', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.reply('Usage: /msg [telegramId] [message text]\nExample: /msg 123456789 မင်္ဂလာပါ!');
    const tid  = parts[1];
    const text = parts.slice(2).join(' ');
    const u = await User.findOne({ telegramId: tid }).catch(() => null);
    if (!u) return ctx.reply(`❌ User ${tid} not found`);
    const ok = await sendTg(tid, `📩 <b>Admin ထံမှ ပြန်စာ:</b>\n\n${esc(text)}`);
    if (ok) {
      await SupportMsg.create({ telegramId: tid, displayName: 'Admin', text, direction: 'admin_to_user' }).catch(() => {});
      ctx.reply(`✅ Message sent to ${esc(u.displayName)} (${tid})`);
    } else {
      ctx.reply(`❌ Failed to send — user may have blocked the bot`);
    }
  });

  // ── /broadcast — Send to all users ───────────────────────────────────────────
  bot.command('broadcast', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const text = ctx.message.text.replace('/broadcast', '').trim();
    if (!text) return ctx.reply('Usage: /broadcast [message]\nExample: /broadcast ကြေညာချက် - ဒီနေ့ ငွေထုတ်ရမည်');
    const users = await User.find({ isBanned: false, isBlocked: false }).select('telegramId').catch(() => []);
    if (!users.length) return ctx.reply('❌ No users to broadcast');
    ctx.reply(`📢 Broadcasting to ${users.length} users...`);
    let sent = 0, failed = 0;
    const BATCH = 20;
    for (let i = 0; i < users.length; i++) {
      const ok = await sendTg(users[i].telegramId, `📢 <b>ကြေညာချက်</b>\n\n${esc(text)}`);
      ok ? sent++ : failed++;
      if ((i + 1) % BATCH === 0) await new Promise(r => setTimeout(r, 1000));
    }
    ctx.reply(`✅ Broadcast ပြီးပါပြီ\n📤 Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}`);
  });

  // ── /ban ───────────────────────────────────────────────────────────────────────
  bot.command('ban', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' '), tid = parts[1], reason = parts.slice(2).join(' ')||'Violated terms';
    if (!tid) return ctx.reply('Usage: /ban [id] [reason]');
    const u = await User.findOneAndUpdate({ telegramId: tid }, { isBanned: true, banReason: reason }, { new: true }).catch(()=>null);
    if (!u) return ctx.reply(`❌ User ${tid} not found`);
    await sendTg(tid, `🚫 Account ပိတ်ထားပါသည်\nအကြောင်း: ${esc(reason)}`);
    ctx.reply(`✅ Banned: ${esc(u.displayName)} (${tid})\nReason: ${esc(reason)}`);
  });

  // ── /unban ─────────────────────────────────────────────────────────────────────
  bot.command('unban', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const tid = ctx.message.text.split(' ')[1];
    if (!tid) return ctx.reply('Usage: /unban [id]');
    const u = await User.findOneAndUpdate({ telegramId: tid }, { isBanned: false, banReason: '' }, { new: true }).catch(()=>null);
    if (!u) return ctx.reply(`❌ Not found`);
    await sendTg(tid, `✅ Account ပြန်ဖွင့်ပေးပြီးပါပြီ`);
    ctx.reply(`✅ Unbanned: ${esc(u.displayName)} (${tid})`);
  });

  // ── /addmoney ──────────────────────────────────────────────────────────────────
  bot.command('addmoney', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const [,tid,amtStr] = ctx.message.text.split(' ');
    if (!tid||!amtStr) return ctx.reply('Usage: /addmoney [id] [amount]');
    const amt = parseInt(amtStr);
    const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: amt, totalEarned: amt } }, { new: true }).catch(()=>null);
    if (!u) return ctx.reply('❌ Not found');
    await sendTg(tid, `💰 Admin မှ ${amt.toLocaleString()} Ks ထည့်ပေးပါပြီ\nလက်ကျန်: ${u.balance.toLocaleString()} Ks`);
    ctx.reply(`✅ Added ${amt.toLocaleString()} Ks → ${esc(u.displayName)}\nNew Balance: ${u.balance.toLocaleString()} Ks`);
  });

  // ── /reducemoney ───────────────────────────────────────────────────────────────
  bot.command('reducemoney', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const [,tid,amtStr] = ctx.message.text.split(' ');
    if (!tid||!amtStr) return ctx.reply('Usage: /reducemoney [id] [amount]');
    const amt = parseInt(amtStr), u = await User.findOne({ telegramId: tid }).catch(()=>null);
    if (!u) return ctx.reply('❌ Not found');
    if (u.balance < amt) return ctx.reply(`❌ Insufficient balance (${u.balance.toLocaleString()} Ks)`);
    await User.findByIdAndUpdate(u._id, { $inc: { balance: -amt } });
    ctx.reply(`✅ Reduced ${amt.toLocaleString()} Ks from ${esc(u.displayName)}`);
  });

  // ── /addrefs ───────────────────────────────────────────────────────────────────
  bot.command('addrefs', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const [,tid,countStr] = ctx.message.text.split(' ');
    if (!tid||!countStr) return ctx.reply('Usage: /addrefs [id] [count]');
    const count = parseInt(countStr), bonus = count * REFERRAL_BONUS;
    const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { referrals: count, balance: bonus, totalEarned: bonus } }, { new: true }).catch(()=>null);
    if (!u) return ctx.reply('❌ Not found');
    ctx.reply(`✅ Added ${count} refs (+${bonus.toLocaleString()} Ks) → ${esc(u.displayName)}`);
  });

  // ── /userinfo ──────────────────────────────────────────────────────────────────
  bot.command('userinfo', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const tid = ctx.message.text.split(' ')[1];
    if (!tid) return ctx.reply('Usage: /userinfo [id]');
    const u = await User.findOne({ telegramId: tid }).catch(()=>null);
    if (!u) return ctx.reply('❌ Not found');
    const pendingWds = await Withdrawal.countDocuments({ telegramId: tid, status: 'pending' });
    ctx.reply(
      `👤 <b>User Info</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📛 Name: ${esc(u.displayName)}\n` +
      `🔖 Username: @${u.username||'N/A'}\n` +
      `🆔 Telegram ID: <code>${u.telegramId}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Balance: ${u.balance.toLocaleString()} Ks\n` +
      `📈 Total Earned: ${u.totalEarned.toLocaleString()} Ks\n` +
      `📤 Total Withdrawn: ${u.totalWithdrawn.toLocaleString()} Ks\n` +
      `👥 Referrals: ${u.referrals} ယောက်\n` +
      `⏳ Pending WD: ${pendingWds}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🚫 Banned: ${u.isBanned ? 'Yes — '+u.banReason : 'No'}\n` +
      `🔇 Bot Blocked: ${u.isBlocked ? 'Yes' : 'No'}\n` +
      `📅 Joined: ${u.createdAt.toLocaleDateString()}\n` +
      `🕐 Last Seen: ${u.lastSeen?.toLocaleDateString()||'N/A'}`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /stats ─────────────────────────────────────────────────────────────────────
  bot.command('stats', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const [total, banned, blocked, pending, approved, rejected] = await Promise.all([
      User.countDocuments(), User.countDocuments({ isBanned: true }),
      User.countDocuments({ isBlocked: true }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'approved' }),
      Withdrawal.countDocuments({ status: 'rejected' }),
    ]);
    const [balRes, todayUsers] = await Promise.all([
      User.aggregate([{ $group: { _id: null, total: { $sum: '$balance' }, totalEarned: { $sum: '$totalEarned' } } }]),
      User.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
    ]);
    ctx.reply(
      `📊 <b>App Statistics</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total Users: <b>${total}</b>\n` +
      `🆕 Today New: <b>${todayUsers}</b>\n` +
      `🚫 Banned: <b>${banned}</b>\n` +
      `🔇 Bot Blocked: <b>${blocked}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏳ Pending WD: <b>${pending}</b>\n` +
      `✅ Approved WD: <b>${approved}</b>\n` +
      `❌ Rejected WD: <b>${rejected}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Total Balance: <b>${(balRes[0]?.total||0).toLocaleString()} Ks</b>\n` +
      `📈 Total Earned: <b>${(balRes[0]?.totalEarned||0).toLocaleString()} Ks</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /listusers [page] — User list with balance & referrals ───────────────────
  bot.command('listusers', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const page  = parseInt(ctx.message.text.split(' ')[1]) || 1;
    const limit = 10;
    const skip  = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(),
    ]);
    if (!users.length) return ctx.reply(`❌ Page ${page} မရှိပါ`);
    const totalPages = Math.ceil(total / limit);
    let text = `👥 <b>User List</b> (Page ${page}/${totalPages} | Total: ${total})\n━━━━━━━━━━━━━━━━━━━━\n`;
    users.forEach((u, i) => {
      text += `${skip+i+1}. <b>${esc(u.displayName)}</b> (@${esc(u.username||'N/A')})\n` +
              `   🆔 <code>${u.telegramId}</code>\n` +
              `   💰 ${u.balance.toLocaleString()} Ks | 👥 ${u.referrals} refs` +
              `${u.isBanned?' 🚫':''}\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━━━\n📄 /listusers ${page+1} (Next page)`;
    ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ── /topusers — Top 10 by referrals ───────────────────────────────────────────
  bot.command('topusers', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const users = await User.find({ isBanned: false }).sort({ referrals: -1, totalEarned: -1 }).limit(10);
    if (!users.length) return ctx.reply('❌ No users');
    let text = `🏆 <b>Top 10 Users (by Referrals)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    users.forEach((u, i) => {
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
      text += `${medal} <b>${esc(u.displayName)}</b>\n` +
              `   👥 ${u.referrals} refs | 💰 ${u.totalEarned.toLocaleString()} Ks earned\n`;
    });
    ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ── /richusers — Top 10 by balance ────────────────────────────────────────────
  bot.command('richusers', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const users = await User.find({ isBanned: false }).sort({ balance: -1 }).limit(10);
    if (!users.length) return ctx.reply('❌ No users');
    let text = `💰 <b>Top 10 Rich Users (by Balance)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    users.forEach((u, i) => {
      text += `${i+1}. <b>${esc(u.displayName)}</b> (@${esc(u.username||'N/A')})\n` +
              `   💰 Balance: ${u.balance.toLocaleString()} Ks\n` +
              `   👥 ${u.referrals} refs | 🆔 <code>${u.telegramId}</code>\n`;
    });
    ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ── /delete [userid] — Full user data + Telegram message wipe ───────────────
  // Steps:
  //   1. Notify user (before DB delete)
  //   2. Fetch all tracked message_ids from BotMessage collection
  //   3. For-loop: deleteMessage via Telegram API with 50ms delay (rate-limit safe)
  //   4. Delete all DB records: BotMessage, SupportMessage, Withdrawal, User
  bot.command('delete', async ctx => {
    if (String(ctx.chat.id) !== ADMIN_ID) return;
    const tid = ctx.message.text.split(' ')[1]?.trim();
    if (!tid) return ctx.reply('Usage: /delete [telegramId]\nExample: /delete 123456789');

    try {
      const u = await User.findOne({ telegramId: tid });
      if (!u) return ctx.reply(`❌ User <code>${esc(tid)}</code> မတွေ့ပါ`, { parse_mode: 'HTML' });

      const displayName = u.displayName;

      // ── Step 1: Notify user first (while we can still reach them) ──────────
      await sendTg(tid,
        `🗑 <b>Account ဖျက်ပြီးပါပြီ</b>\n\n` +
        `လူကြီးမင်း၏ Account နှင့် Data အားလုံးကို Admin မှ ဖျက်ပြီးပါပြီ။\n` +
        `ပြန်လည် စတင်ရန် /start နှိပ်ပါ။`
      );

      // Show progress to admin
      const progressMsg = await ctx.reply(
        `⏳ <b>Deleting messages for ${esc(displayName)}...</b>\nဖျက်နေဆဲ — ခဏစောင့်ပါ`,
        { parse_mode: 'HTML' }
      );

      // ── Step 2: Fetch all tracked message_ids from BotMessage collection ───
      const trackedMsgs = await BotMessage.find({ telegramId: tid }).select('messageId').lean();
      const messageIds  = trackedMsgs.map(m => m.messageId);

      // ── Step 3: Delete each Telegram message with rate-limit delay ──────────
      // Telegram Bot API allows bots to delete their own messages in private chats.
      // Messages older than 48 hours will fail silently (Telegram limitation).
      let tgDeleted = 0, tgFailed = 0;

      for (let i = 0; i < messageIds.length; i++) {
        try {
          await bot.telegram.deleteMessage(tid, messageIds[i]);
          tgDeleted++;
        } catch {
          // "message to delete not found" = already gone or >48hr old — ignore
          tgFailed++;
        }
        // 50ms delay between calls to stay well under Telegram's rate limit
        await new Promise(r => setTimeout(r, 50));
      }

      // ── Step 4: Wipe all DB records atomically ─────────────────────────────
      const [wdResult, smResult] = await Promise.all([
        Withdrawal.deleteMany({ telegramId: tid }),
        SupportMsg.deleteMany({ telegramId: tid }),
      ]);
      await BotMessage.deleteMany({ telegramId: tid });
      await User.deleteOne({ telegramId: tid });

      // ── Step 5: Update admin progress message with final report ────────────
      const report =
        `🗑 <b>Delete Complete</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User: <b>${esc(displayName)}</b>\n` +
        `🆔 ID: <code>${tid}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 Telegram Messages\n` +
        `   ✅ Deleted: ${tgDeleted}\n` +
        `   ⚠️ Skipped (>48hr / not found): ${tgFailed}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🗄 Database Records\n` +
        `   💸 Withdrawals: ${wdResult.deletedCount}\n` +
        `   💬 Support msgs: ${smResult.deletedCount}\n` +
        `   ✅ User record: Deleted\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📲 User ဆီ notification ပို့ပြီးပါပြီ`;

      await bot.telegram.editMessageText(ADMIN_ID, progressMsg.message_id, undefined, report, { parse_mode: 'HTML' })
        .catch(() => ctx.reply(report, { parse_mode: 'HTML' }));

    } catch (err) {
      console.error('[/delete] error:', err.message);
      ctx.reply(`❌ Error: ${esc(err.message)}`);
    }
  });


  bot.on(message('text'), async ctx => {
    if (ctx.message.text.startsWith('/')) return;
    const chatId = String(ctx.chat.id);

    if (chatId === ADMIN_ID) {
      if (pendingReplies[ADMIN_ID]) {
        const targetId = pendingReplies[ADMIN_ID]; delete pendingReplies[ADMIN_ID];
        await sendTg(targetId, `📩 <b>Admin ထံမှ ပြန်စာ:</b>\n\n${esc(ctx.message.text)}`);
        await SupportMsg.create({ telegramId: targetId, displayName: 'Admin', text: ctx.message.text, direction: 'admin_to_user' }).catch(()=>{});
        return ctx.reply(`✅ Reply sent to ${targetId}`);
      }
      if (pendingRejections[ADMIN_ID]) {
        const wdId = pendingRejections[ADMIN_ID]; delete pendingRejections[ADMIN_ID];
        const reason = ctx.message.text;
        const wd = await Withdrawal.findById(wdId).populate('user').catch(()=>null);
        if (wd && wd.status === 'pending') {
          wd.status = 'rejected'; wd.rejectionReason = reason; wd.reviewedAt = new Date();
          wd.deletedAt = new Date(); // TTL auto-delete trigger
          await wd.save();
          await User.findByIdAndUpdate(wd.user._id, { $inc: { balance: wd.amount + wd.fee } });
          await sendTg(wd.telegramId,
            `❌ <b>ငွေထုတ်ယူမှု ငြင်းပယ်ပါသည်</b>\n\nအကြောင်းပြချက်: ${reason}\n\n💰 ${(wd.amount+wd.fee).toLocaleString()} Ks ပြန်ထည့်ပေးပြီးပါပြီ`
          );
          return ctx.reply(`✅ Rejected — ${wd.telegramId} balance refunded`);
        }
        return ctx.reply('❌ Not found or already processed');
      }
      return;
    }

    // User support message
    const u = await User.findOne({ telegramId: chatId }).catch(()=>null);
    if (!u || u.isBanned) return;

    // Track user's incoming message_id so /delete can wipe it later
    if (ctx.message?.message_id) {
      BotMessage.create({ telegramId: chatId, messageId: ctx.message.message_id }).catch(() => {});
    }

    await SupportMsg.create({ telegramId: chatId, displayName: u.displayName, text: ctx.message.text, direction: 'user_to_admin' }).catch(()=>{});
    if (ADMIN_ID) {
      await sendTg(ADMIN_ID,
        `📨 <b>Support Message</b>\n👤 ${esc(u.displayName)} (@${esc(u.username||'N/A')})\n🆔 <code>${chatId}</code>\n\n💬 ${esc(ctx.message.text)}`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Reply', callback_data: `reply_${chatId}` }]] } }
      );
    }
    ctx.reply('✅ မက်ဆေ့ကို Admin ထံ ပေးပို့ပြီးပါပြီ။ မကြာမီ ပြန်လည်ဖြေကြားပါမည်။');
  });

  // Referral link share message
  bot.on(message('text'), async ctx => {
    // Already handled above — this catches text for broadcast-like ref messages
  });

  // Inline button callbacks
  bot.on('callback_query', async ctx => {
    const adminId = String(ctx.from.id);
    const data    = ctx.callbackQuery.data;

    // ── Channel join check (any user) ─────────────────────────────────────────
    if (data.startsWith('check_join_')) {
      const userId = String(ctx.from.id);
      const joined = await isChannelMember(userId);
      if (!joined) {
        await ctx.answerCbQuery('⚠️ Channel မ Join ရသေးပါ။ Join ပြီးမှ ထပ်နှိပ်ပါ။', { show_alert: true });
        return;
      }
      // Joined — delete the join prompt message
      await ctx.deleteMessage().catch(() => {});
      await ctx.answerCbQuery('✅ Channel Join ပြီးပါပြီ!');

      // Extract referral code from callback_data: "check_join_{userId}_{refCode}"
      const parts    = data.split('_');
      // format: check | join | {userId} | {refCode or empty}
      // e.g. "check_join_123456789_ref_987654321" → parts[3..] = refCode
      const rawRef   = parts.slice(3).join('_'); // handles "ref_12345" format too
      const startParam = rawRef || '';

      const tgUser = ctx.from, chatId = userId;
      try {
        let user = await User.findOne({ telegramId: chatId });
        if (!user) {
          const myCode = `ref_${chatId}`;
          user = new User({
            telegramId: chatId, firstName: tgUser.first_name||'',
            lastName: tgUser.last_name||'', username: tgUser.username||'',
            referralCode: myCode,
          });

          // Process referral if present
          if (startParam) {
            const cleanRefId = startParam.replace('ref_', '');
            if (cleanRefId && cleanRefId !== chatId) {
              const referrer = await User.findOne({ telegramId: cleanRefId });
              if (referrer && !referrer.isBanned) {
                await User.findByIdAndUpdate(referrer._id, {
                  $inc: { balance: REFERRAL_BONUS, totalEarned: REFERRAL_BONUS, referrals: 1 },
                });
                user.referredBy = cleanRefId;
                // Notify referrer with details
                await sendTg(cleanRefId,
                  `🎉 <b>မိတ်ဆွေသစ် တစ်ယောက် ရောက်လာပါပြီ!</b>\n\n` +
                  `👤 <b>ဖိတ်ကြားခံရသူ:</b> ${esc(tgUser.first_name)}${tgUser.username ? ' (@'+tgUser.username+')' : ''}\n` +
                  `💰 <b>Referral Bonus:</b> ${REFERRAL_BONUS.toLocaleString()} Ks ထည့်ပေးပြီးပါပြီ။\n\n` +
                  `🔗 ဆက်လက်ဖိတ်ကြားပြီး ပိုမိုသောဆုချီးမြှင့်မှုများ ရယူပါ!`
                );
              }
            }
          }

          await user.save();
        } else {
          await User.findByIdAndUpdate(user._id, {
            firstName: tgUser.first_name||user.firstName,
            lastName:  tgUser.last_name ||user.lastName,
            username:  tgUser.username  ||user.username,
            lastSeen:  new Date(), isBlocked: false,
          });
        }

        if (user.isBanned) return ctx.reply(`🚫 Account ပိတ်ထားပါသည်\nအကြောင်း: ${esc(user.banReason)}`);

        await ctx.reply(
          `👋 မင်္ဂလာပါ ${esc(tgUser.first_name)}\n` +
          `KBZPay Mini App မှ ကြိုဆိုပါသည် 🎉\n\n` +
          `💰 ယခုပဲ <b>💰 App ဖွင့်မည်</b> ကိုနှိပ်ပြီး ပိုက်ဆံများ စတင်ရှာဖွေလိုက်ပါ။\n\n` +
          `👥 အထူးအစီအစဉ်အနေဖြင့် မိမိ၏ သူငယ်ချင်းများကို ဖိတ်ခေါ်ပြီး တစ်ယောက်လျှင် ` +
          `<b>၅,၀၀၀ ကျပ်</b> စီ အခမဲ့ ရယူကာ ပိုက်ဆံများ အမြန်ဆုံး ထုတ်ယူနိုင်ပါပြီ။`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[
              { text: '💰 App ဖွင့်မည်', web_app: { url: FRONTEND_URL } },
            ]]},
          }
        );
      } catch (e) { console.error('check_join register error:', e.message); }
      return;
    }

    // Admin-only callbacks below
    if (adminId !== ADMIN_ID) return ctx.answerCbQuery('⛔ Unauthorized');

    if (data.startsWith('reply_')) {
      pendingReplies[ADMIN_ID] = data.replace('reply_','');
      await ctx.answerCbQuery('📝 Type reply now');
      return ctx.reply(`✏️ Type your reply for user <code>${pendingReplies[ADMIN_ID]}</code>:`, { parse_mode: 'HTML' });
    }

    if (data.startsWith('wd_approve_')) {
      const wdId = data.replace('wd_approve_','');
      const wd   = await Withdrawal.findById(wdId).populate('user').catch(()=>null);
      if (!wd || wd.status !== 'pending') return ctx.answerCbQuery('⚠️ Already processed');
      wd.status = 'approved'; wd.reviewedAt = new Date(); await wd.save();
      await User.findByIdAndUpdate(wd.user._id, { $inc: { totalWithdrawn: wd.netAmount } });
      await ctx.answerCbQuery('✅ Approved!');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(()=>{});
      await sendTg(wd.telegramId,
        `✅ <b>ငွေထုတ်ယူမှု အတည်ပြုပြီးပါပြီ!</b>\n\n💰 <b>${wd.netAmount.toLocaleString()} Ks</b> ကို မကြာမီ ပေးပို့ပါမည်\n📅 ${new Date().toLocaleString()}`
      );
      return ctx.reply(`✅ <b>Approved!</b>\n👤 ${esc(wd.user?.displayName)}\n💰 ${wd.netAmount.toLocaleString()} Ks`, { parse_mode: 'HTML' });
    }

    if (data.startsWith('wd_reject_')) {
      pendingRejections[ADMIN_ID] = data.replace('wd_reject_','');
      await ctx.answerCbQuery('✏️ Send rejection reason');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(()=>{});
      return ctx.reply(
        `📝 <b>ငြင်းပယ်ရမည့် အကြောင်းပြချက် ရေးပါ</b>\nWithdrawal ID: <code>${pendingRejections[ADMIN_ID]}</code>\n\n` +
        `ဤ message ကို User ဆီ တိုက်ရိုက်ပေးပို့ပါမည်`,
        { parse_mode: 'HTML' }
      );
    }

    ctx.answerCbQuery();
  });

  // Handle referral link sharing — when user shares their ref link via bot
  bot.on(message('text'), async ctx => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text || '';
    // If user shares their referral link, send promotional message
    if (text.includes(`t.me/${BOT_USERNAME}?start=ref_`)) {
      try {
        await ctx.reply(
          `📱 ဖုန်းတစ်လုံးရှိရုံနဲ့ တစ်နေ့ ၁ သိန်းအထိ ရှာလို့ရမယ့် အခွင့်အရေး! 💸\n\n` +
          `KBZPay နဲ့ ချိတ်ဆက်ထားတဲ့ Pay to Pay စနစ်သစ်မှာ အခုပဲ ပါဝင်လိုက်ပါ။ ` +
          `သူငယ်ချင်းတွေကို ဖိတ်ခေါ်ပြီးတော့လည်း Bonus တွေ အများကြီး ထုတ်ယူနိုင်ပါပြီ။\n\n` +
          `✅ စိတ်ချရမှု ၁၀၀% အာမခံပါသည်။\n\n👇 အခုပဲ စာရင်းသွင်းပါ -\n${esc(text)}`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { console.warn('Ref link reply error:', e.message); }
    }
  });

  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 Bot started'))
    .catch(e => console.error('Bot launch error:', e.message));

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ═══════════════════════════════════════════════════════════════
//  MONGOOSE CONNECTION WITH AUTO-RECONNECT
// ═══════════════════════════════════════════════════════════════
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      heartbeatFrequencyMS: 30000,
    });
    isConnected = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('🔄 Retrying in 5 seconds...');
    setTimeout(connectDB, 5000);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected — attempting reconnect...');
  isConnected = false;
  setTimeout(connectDB, 3000);
});

mongoose.connection.on('reconnected', () => {
  isConnected = true;
  console.log('✅ MongoDB reconnected');
});

// ═══════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════
(async () => {
  await connectDB();
  initBot();
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
})();

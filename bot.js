const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ─── Config ───
if (!process.env.TELEGRAM_BOT_TOKEN) {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[FATAL] TELEGRAM_BOT_TOKEN is not set. Add it to .env or environment.');
  process.exit(1);
}

const BOT_USERNAME = process.env.BOT_USERNAME || 'skillbridge_hub_bot';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ADMIN_IDS.length === 0) {
  console.warn('[WARN] No ADMIN_IDS configured. Admin features will be unavailable.');
}
let offset = 0;
let pollingActive = false;
let shutdownRequested = false;

// ─── Logging ───
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

function log(level, ...args) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

// ─── Database ───
const dbPath = process.env.DB_PATH || path.join(__dirname, 'skillbridge.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ─── Quiz Pool Tables ───
db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    questionText TEXT NOT NULL,
    options TEXT NOT NULL,
    correctOptionIndex INTEGER NOT NULL,
    explanation TEXT,
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    questionId INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    FOREIGN KEY (questionId) REFERENCES quiz_pool(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_daily_selection_date ON daily_selection(date);
  CREATE INDEX IF NOT EXISTS idx_quiz_pool_category ON quiz_pool(category, isActive);
`);

// ─── Core Tables ───
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegramId TEXT UNIQUE NOT NULL,
    username TEXT,
    firstName TEXT NOT NULL,
    lastName TEXT,
    country TEXT,
    city TEXT,
    xp INTEGER NOT NULL DEFAULT 0,
    skillPoints INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'Explorer',
    rank INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    projectsCompleted INTEGER NOT NULL DEFAULT 0,
    projectsSubmitted INTEGER NOT NULL DEFAULT 0,
    challengesCompleted INTEGER NOT NULL DEFAULT 0,
    quizzesCompleted INTEGER NOT NULL DEFAULT 0,
    communityContributions INTEGER NOT NULL DEFAULT 0,
    pythonChallenges INTEGER NOT NULL DEFAULT 0,
    fullstackChallenges INTEGER NOT NULL DEFAULT 0,
    aiChallenges INTEGER NOT NULL DEFAULT 0,
    dataChallenges INTEGER NOT NULL DEFAULT 0,
    cyberChallenges INTEGER NOT NULL DEFAULT 0,
    odooChallenges INTEGER NOT NULL DEFAULT 0,
    uiuxChallenges INTEGER NOT NULL DEFAULT 0,
    competitionsWon INTEGER NOT NULL DEFAULT 0,
    referralsCount INTEGER NOT NULL DEFAULT 0,
    referralCode TEXT,
    referredBy INTEGER,
    isAdmin INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    lastActiveAt TEXT,
    lastQuizAt TEXT,
    lastChallengeAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    icon TEXT,
    description TEXT,
    requirement TEXT NOT NULL,
    skillPointsReward INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    badgeId INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    awardedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (badgeId) REFERENCES badges(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    timeLimitSeconds INTEGER NOT NULL DEFAULT 120,
    totalPoints INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    isDaily INTEGER NOT NULL DEFAULT 0,
    availableFrom TEXT,
    availableUntil TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    questionText TEXT NOT NULL,
    options TEXT NOT NULL,
    correctOptionIndex INTEGER NOT NULL,
    explanation TEXT,
    points INTEGER NOT NULL DEFAULT 10,
    "order" INTEGER NOT NULL,
    quizId INTEGER NOT NULL,
    FOREIGN KEY (quizId) REFERENCES quizzes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    quizId INTEGER NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    totalPoints INTEGER NOT NULL DEFAULT 0,
    correctAnswers INTEGER NOT NULL DEFAULT 0,
    totalQuestions INTEGER NOT NULL DEFAULT 0,
    timeTakenSeconds INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (quizId) REFERENCES quizzes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 100,
    difficulty INTEGER NOT NULL DEFAULT 1,
    isActive INTEGER NOT NULL DEFAULT 1,
    isDaily INTEGER NOT NULL DEFAULT 0,
    isWeekly INTEGER NOT NULL DEFAULT 0,
    isMonthly INTEGER NOT NULL DEFAULT 0,
    availableFrom TEXT,
    availableUntil TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS challenge_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    challengeId INTEGER NOT NULL,
    solution TEXT,
    githubUrl TEXT,
    liveDemoUrl TEXT,
    documentation TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    pointsAwarded INTEGER NOT NULL DEFAULT 0,
    reviewedBy TEXT,
    reviewFeedback TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (challengeId) REFERENCES challenges(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    skillPointsCost INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT -1,
    imageUrl TEXT,
    category TEXT DEFAULT 'course_discount',
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reward_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    rewardId INTEGER NOT NULL,
    pointsSpent INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (rewardId) REFERENCES rewards(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL,
    startsAt TEXT NOT NULL,
    endsAt TEXT,
    registrationUrl TEXT,
    maxAttendees INTEGER NOT NULL DEFAULT 0,
    currentAttendees INTEGER NOT NULL DEFAULT 0,
    skillPointsReward INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    notificationSent INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS event_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    eventId INTEGER NOT NULL,
    registeredAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (eventId) REFERENCES events(id) ON DELETE CASCADE
  );
`);

// ─── UI Constants ───
const HR = '━━━━━━━━━━━━━━━━━━━━━━━━━';
const HR2 = '───────────────────────────';
const BOX_W = 30;
const ctr = (s, w = BOX_W) => { const pad = w - s.length; return pad > 0 ? ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2)) : s; };
const bx = (lines) => '┌' + '─'.repeat(BOX_W) + '┐\n' + lines.map(l => '│' + ctr(l) + '│').join('\n') + '\n└' + '─'.repeat(BOX_W) + '┘';
const bxl = (lines, icon, label, val) => bx(lines.concat([`${icon} ${label}: ${val}`]));
const hr = () => '━'.repeat(BOX_W);
const hr2 = () => '─'.repeat(BOX_W);
const LEVELS = [
  { name: '🧭 Explorer', xp: 0 },
  { name: '📚 Learner', xp: 100 },
  { name: '🔨 Builder', xp: 500 },
  { name: '💻 Developer', xp: 1500 },
  { name: '🏢 Professional', xp: 5000 },
  { name: '🧠 Expert', xp: 15000 },
  { name: '🎓 Mentor', xp: 50000 },
  { name: '🌍 Ambassador', xp: 150000 },
  { name: '👑 Master', xp: 500000 },
];

// ─── DB Helpers ───
function getOrCreateUser(telegramId, firstName, username) {
  let user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(telegramId));
  if (!user) {
    const code = 'ref_' + telegramId;
    db.prepare(`INSERT INTO users (telegramId, username, firstName, xp, skillPoints, level, rank, streak, projectsCompleted, projectsSubmitted, challengesCompleted, quizzesCompleted, communityContributions, pythonChallenges, fullstackChallenges, aiChallenges, dataChallenges, cyberChallenges, odooChallenges, uiuxChallenges, competitionsWon, referralsCount, isAdmin, isActive, referralCode) VALUES (?, ?, ?, 0, 0, 'Explorer', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ?)`).run(String(telegramId), username || '', firstName || '', code);
    user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(telegramId));
  } else if (firstName && user.firstName !== firstName) {
    db.prepare('UPDATE users SET firstName = ?, username = ? WHERE id = ?').run(firstName, username || '', user.id);
    user.firstName = firstName;
    user.username = username || '';
  }
  return user;
}

function updateUser(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets}, updatedAt = datetime('now') WHERE id = ?`).run(...Object.values(fields), id);
}

function getLevel(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xp) lvl = l; }
  return lvl;
}

function getNextLevel(xp) {
  for (const l of LEVELS) { if (xp < l.xp) return l; }
  return null;
}

function awardSP(user, amount) {
  const oldLevel = getLevel(user.xp);
  const newXP = user.xp + amount;
  const newLevel = getLevel(newXP);
  const leveled = newLevel.xp > oldLevel.xp;
  updateUser(user.id, { xp: newXP, skillPoints: user.skillPoints + amount, level: newLevel.name });
  return { newLevel, leveled, oldLevel };
}

function updateStreak(user) {
  const now = new Date();
  let bonus = 0;
  let streak = user.streak || 0;
  if (user.lastActiveAt) {
    const last = new Date(user.lastActiveAt);
    const diff = Math.floor((now - last) / 86400000);
    if (diff === 1) streak += 1;
    else if (diff > 1) streak = 1;
  } else {
    streak = 1;
  }
  if (streak === 3) bonus = 15;
  if (streak === 7) bonus = 50;
  if (streak === 14) bonus = 100;
  if (streak === 30) bonus = 300;
  const fields = { streak, lastActiveAt: now.toISOString() };
  if (bonus > 0) {
    fields.skillPoints = user.skillPoints + bonus;
    fields.xp = user.xp + bonus;
  }
  updateUser(user.id, fields);
  return { streak, bonus };
}

function checkBadges(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return [];
  const allBadges = db.prepare('SELECT * FROM badges WHERE isActive = 1').all();
  const earned = db.prepare('SELECT badgeId FROM user_badges WHERE userId = ?').all(userId).map(r => r.badgeId);
  const newBadges = [];
  for (const b of allBadges) {
    if (earned.includes(b.id)) continue;
    let met = false;
    const req = b.requirement || '';
    if (req.startsWith('python_')) met = user.pythonChallenges >= parseInt(req.split('_')[1]) || user.challengesCompleted >= parseInt(req.split('_')[1]);
    else if (req.startsWith('fullstack_')) met = user.challengesCompleted >= parseInt(req.split('_')[1]);
    else if (req.startsWith('ai_')) met = user.aiChallenges >= parseInt(req.split('_')[1]);
    else if (req.startsWith('help_')) met = user.communityContributions >= parseInt(req.split('_')[1]);
    else if (req.startsWith('streak_')) met = user.streak >= parseInt(req.split('_')[1]);
    else if (req.startsWith('projects_')) met = (user.projectsCompleted || 0) >= parseInt(req.split('_')[1]) || (user.projectsSubmitted || 0) >= parseInt(req.split('_')[1]);
    else if (req === 'win_competition' || req === 'hackathon_win') met = user.competitionsWon >= 1;
    if (met) {
      db.prepare('INSERT OR IGNORE INTO user_badges (userId, badgeId, awardedAt) VALUES (?, ?, datetime(\'now\'))').run(userId, b.id);
      if (b.skillPointsReward > 0) {
        awardSP(user, b.skillPointsReward);
        user.xp = user.xp + b.skillPointsReward;
        user.skillPoints = user.skillPoints + b.skillPointsReward;
      }
      newBadges.push(b);
    }
  }
  return newBadges;
}

// ─── Quiz Pool Functions ───
const CATEGORIES = ['Python', 'AI', 'Cybersecurity', 'Full-Stack', 'Data Science'];

const CATEGORY_BY_DAY = {
  0: 'Python',        // Monday
  1: 'AI',            // Tuesday
  2: 'Cybersecurity', // Wednesday
  3: 'Full-Stack',    // Thursday
  4: 'Data Science',  // Friday
  5: 'mixed',         // Saturday
  6: 'mixed',         // Sunday
};

function syncPoolFromFile() {
  const filePath = path.join(__dirname, 'questions.json');
  if (!fs.existsSync(filePath)) {
    log('warn', 'questions.json not found, skipping pool sync');
    return { added: 0, updated: 0, skipped: 0 };
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const categories = data.categories || {};
  let added = 0, updated = 0, skipped = 0;
  const insertStmt = db.prepare('INSERT INTO quiz_pool (category, questionText, options, correctOptionIndex, explanation) VALUES (?, ?, ?, ?, ?)');
  const updateStmt = db.prepare('UPDATE quiz_pool SET options = ?, correctOptionIndex = ?, explanation = ? WHERE questionText = ? AND category = ?');
  const checkStmt = db.prepare('SELECT id FROM quiz_pool WHERE questionText = ? AND category = ?');

  const syncAll = db.transaction(() => {
    for (const [category, questions] of Object.entries(categories)) {
      if (!Array.isArray(questions)) continue;
      for (const q of questions) {
        const opts = Array.isArray(q.options) ? q.options.join(',') : q.options;
        const existing = checkStmt.get(q.question, category);
        if (existing) {
          updateStmt.run(opts, q.correct, q.explanation || '', q.question, category);
          updated++;
        } else {
          insertStmt.run(category, q.question, opts, q.correct, q.explanation || '');
          added++;
        }
      }
    }
  });
  syncAll();
  log('info', `Pool sync: +${added} added, ~${updated} updated`);
  return { added, updated, skipped };
}

function seedChallenges() {
  const count = db.prepare('SELECT COUNT(*) as c FROM challenges').get().c;
  if (count > 0) return { seeded: 0 };
  const filePath = path.join(__dirname, 'challenges.json');
  if (!fs.existsSync(filePath)) {
    log('warn', 'challenges.json not found, skipping challenge seed');
    return { seeded: 0 };
  }
  const challenges = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(challenges) || challenges.length === 0) return { seeded: 0 };
  const stmt = db.prepare('INSERT INTO challenges (title, description, category, points, difficulty, isActive, isDaily, isWeekly, isMonthly) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)');
  const seedAll = db.transaction(() => {
    for (const c of challenges) {
      stmt.run(c.title, c.description, c.category, c.points, c.difficulty, c.isDaily || 0, c.isWeekly || 0, c.isMonthly || 0);
    }
  });
  seedAll();
  log('info', `Seeded ${challenges.length} challenges from challenges.json`);
  return { seeded: challenges.length };
}

function selectTodayQuestions() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT ds.*, qp.questionText, qp.options, qp.correctOptionIndex, qp.explanation, qp.category FROM daily_selection ds JOIN quiz_pool qp ON ds.questionId = qp.id WHERE ds.date = ? ORDER BY ds."order" ASC').all(today);
  if (existing.length >= 5) return existing;

  db.prepare('DELETE FROM daily_selection WHERE date = ?').run(today);
  const dayOfWeek = new Date().getDay();
  const targetCategory = CATEGORY_BY_DAY[dayOfWeek];

  let selected = [];
  if (targetCategory !== 'mixed') {
    const recentIds = db.prepare(`SELECT questionId FROM daily_selection WHERE date > date('now', '-30 days')`).all().map(r => r.questionId);
    if (recentIds.length > 0) {
      const placeholders = recentIds.map(() => '?').join(',');
      selected = db.prepare(`SELECT * FROM quiz_pool WHERE isActive = 1 AND category = ? AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 5`).all(targetCategory, ...recentIds);
    } else {
      selected = db.prepare(`SELECT * FROM quiz_pool WHERE isActive = 1 AND category = ? ORDER BY RANDOM() LIMIT 5`).all(targetCategory);
    }
  }

  if (selected.length < 5) {
    const recentIds = db.prepare(`SELECT questionId FROM daily_selection WHERE date > date('now', '-30 days')`).all().map(r => r.questionId);
    const usedIds = [...selected.map(q => q.id), ...recentIds];
    const remaining = 5 - selected.length;
    if (usedIds.length > 0) {
      const placeholders = usedIds.map(() => '?').join(',');
      const mixed = db.prepare(`SELECT * FROM quiz_pool WHERE isActive = 1 AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT ?`).all(...usedIds, remaining);
      selected = [...selected, ...mixed];
    } else {
      const mixed = db.prepare(`SELECT * FROM quiz_pool WHERE isActive = 1 ORDER BY RANDOM() LIMIT ?`).all(remaining);
      selected = [...selected, ...mixed];
    }
  }

  const insertSelection = db.prepare('INSERT INTO daily_selection (date, questionId, "order") VALUES (?, ?, ?)');
  const insertAll = db.transaction(() => {
    selected.forEach((q, i) => insertSelection.run(today, q.id, i + 1));
  });
  insertAll();

  return selected.map((q, i) => ({
    id: q.id,
    date: today,
    questionId: q.id,
    order: i + 1,
    questionText: q.questionText,
    options: q.options,
    correctOptionIndex: q.correctOptionIndex,
    explanation: q.explanation,
    category: q.category,
  }));
}

function getPoolStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM quiz_pool WHERE isActive = 1').get().c;
  const byCategory = db.prepare('SELECT category, COUNT(*) as c FROM quiz_pool WHERE isActive = 1 GROUP BY category').all();
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = db.prepare('SELECT COUNT(*) as c FROM daily_selection WHERE date = ?').get(today).c;
  const totalUsed = db.prepare('SELECT COUNT(DISTINCT questionId) as c FROM daily_selection').get().c;
  const remaining = total - totalUsed;
  const daysCovered = Math.floor(total / 5);
  return { total, byCategory, usedToday, totalUsed, remaining, daysCovered };
}

function startPoolQuiz(chatId, userId) {
  const questions = selectTodayQuestions();
  if (!questions || questions.length === 0) {
    return send(chatId, 'No questions available. Add questions to questions.json and run /reloadpool.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date().getDay();
  const catLabel = CATEGORY_BY_DAY[dayOfWeek] === 'mixed' ? 'Mixed Categories' : CATEGORY_BY_DAY[dayOfWeek];
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const quizObj = { id: 0, title: `📅 Daily Quiz — ${catLabel}`, totalPoints: questions.length * 10 };

  quizSessions[userId] = {
    quizId: 0,
    isPoolQuiz: true,
    questions: questions.map(q => ({
      id: q.questionId,
      questionText: q.questionText,
      options: q.options,
      correctOptionIndex: q.correctOptionIndex,
      explanation: q.explanation,
      points: 10,
    })),
    qIndex: 0,
    score: 0,
    answers: [],
    startTime: Date.now(),
  };
  sessionTimestamps[userId] = Date.now();
  showQuestion(chatId, userId, quizObj, quizSessions[userId].questions, 0);
}

function bar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function difficultyBar(n) { return '●'.repeat(n) + '○'.repeat(5 - n); }

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

function rankEmoji(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return `#${i + 1}`;
}

function progressLabel(pct) {
  if (pct >= 100) return 'MAX';
  if (pct >= 75) return 'Almost there!';
  if (pct >= 50) return 'Halfway!';
  if (pct >= 25) return 'Growing!';
  return 'Just started!';
}

function isAdmin(userId) { return ADMIN_IDS.includes(String(userId)); }

// ─── Telegram API ───
function apiCall(method, body) {
  const data = body ? JSON.stringify(body) : null;
  const fullUrl = `${API}/${method}`;

  function attempt(retries) {
    return new Promise((resolve, reject) => {
      if (data) {
        const urlObj = new URL(fullUrl);
        const options = {
          hostname: urlObj.hostname, port: 443, path: urlObj.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 30000, family: 4,
        };
        const req = https.request(options, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); } });
        });
        req.on('error', (err) => {
          if (retries > 0) { const delay = Math.pow(2, 3 - retries) * 1000; setTimeout(() => attempt(retries - 1).then(resolve, reject), delay); }
          else reject(err);
        });
        req.on('timeout', () => {
          req.destroy();
          if (retries > 0) { const delay = Math.pow(2, 3 - retries) * 1000; setTimeout(() => attempt(retries - 1).then(resolve, reject), delay); }
          else reject(new Error('timeout'));
        });
        req.write(data);
        req.end();
      } else {
        const req = https.get(fullUrl, { timeout: 30000, family: 4 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); } });
        });
        req.on('error', (err) => {
          if (retries > 0) { const delay = Math.pow(2, 3 - retries) * 1000; setTimeout(() => attempt(retries - 1).then(resolve, reject), delay); }
          else reject(err);
        });
        req.on('timeout', () => {
          req.destroy();
          if (retries > 0) { const delay = Math.pow(2, 3 - retries) * 1000; setTimeout(() => attempt(retries - 1).then(resolve, reject), delay); }
          else reject(new Error('timeout'));
        });
      }
    });
  }

  return attempt(3);
}

function mainMenuKeyboard(userId) {
  const rows = [
    [{ text: '📝 Daily Quiz' }, { text: '👤 Profile' }],
    [{ text: '🏆 Challenges' }, { text: '📊 Leaderboard' }],
    [{ text: '🎁 Rewards' }, { text: '📅 Events' }],
    [{ text: '🔗 Referral' }],
  ];
  if (isAdmin(userId)) {
    rows.push([{ text: '⚙️ Admin Panel' }]);
  }
  rows.push([{ text: '❓ Help' }]);
  return JSON.stringify({ keyboard: rows, resize_keyboard: true, is_persistent: true });
}

function hideKeyboard() {
  return JSON.stringify({ remove_keyboard: true });
}

const menuTextHandlers = {
  '📝 Daily Quiz': '/daily',
  '👤 Profile': '/profile',
  '🏆 Challenges': '/challenges',
  '📊 Leaderboard': '/leaderboard',
  '🎁 Rewards': '/rewards',
  '📅 Events': '/events',
  '🔗 Referral': '/referral',
  '❓ Help': '/help',
  '⚙️ Admin Panel': '/admin',
};

function send(chatId, text, extra = {}) {
  return apiCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }).catch(() =>
    apiCall('sendMessage', { chat_id: chatId, text }).catch(() => {})
  );
}

function sendPhoto(chatId, photoPath, caption, extra = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const url = new URL(`${API}/sendPhoto`);
    const photoData = fs.readFileSync(photoPath);
    const fields = { chat_id: String(chatId), caption, parse_mode: 'HTML', ...extra };

    let body = '';
    for (const [key, val] of Object.entries(fields)) {
      const v = (key === 'reply_markup' && typeof val === 'object') ? JSON.stringify(val) : String(val);
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${v}\r\n`;
    }
    body += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${path.basename(photoPath)}"\r\nContent-Type: image/png\r\n\r\n`;

    const header = Buffer.from(body, 'utf8');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([header, photoData, footer]);

    const options = {
      hostname: url.hostname, port: 443, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length },
      timeout: 30000, family: 4,
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  }).catch(() => send(chatId, caption, extra));
}

function answerCB(qid, text = '') {
  return apiCall('answerCallbackQuery', { callback_query_id: qid, text, show_alert: false }).catch(() => {});
}

// ─── State ───
const quizSessions = {};
const adminFlows = {};
const userFlows = {};
const handlers = {};
const sessionTimestamps = {};
const flowTimestamps = {};

const SESSION_TTL = 30 * 60 * 1000;
const ADMIN_FLOW_TTL = 15 * 60 * 1000;

// Periodic cleanup of expired sessions to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of Object.entries(sessionTimestamps)) {
    if (now - ts > SESSION_TTL) {
      delete quizSessions[k];
      delete sessionTimestamps[k];
    }
  }
  for (const [k, ts] of Object.entries(flowTimestamps)) {
    if (now - ts > ADMIN_FLOW_TTL) {
      delete adminFlows[k];
      delete userFlows[k];
      delete flowTimestamps[k];
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
//  USER COMMANDS
// ═══════════════════════════════════════════

handlers['/start'] = (msg) => {
  const existingUser = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(msg.from.id));
  const isNewUser = !existingUser;
  const user = getOrCreateUser(msg.from.id, msg.from.first_name, msg.from.username);
  const { streak, bonus } = updateStreak(user);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const lvl = getLevel(u.xp);

  let streakText = '';
  if (bonus > 0) streakText = `\n▸ Streak bonus: +${bonus} SP (Day ${streak})`;

  const startParam = msg.text ? msg.text.split(' ')[1] : null;
  let referralText = '';
  if (startParam && startParam.startsWith('ref_') && !u.referredBy) {
    const referrerId = parseInt(startParam.replace('ref_', ''));
    const referrer = db.prepare('SELECT * FROM users WHERE id = ?').get(referrerId);
    if (referrer && referrer.id !== u.id) {
      awardSP(referrer, 25);
      updateUser(referrer.id, { referralsCount: (referrer.referralsCount || 0) + 1 });
      updateUser(u.id, { referredBy: referrer.id });
      referralText = `\n\nReferred by *${esc(referrer.firstName)}* — they earned 25 SP.`;
    }
  }

  const buttons = [
    [{ text: '📝 Daily Quiz', callback_data: 'nav_daily' }, { text: '👤 Profile', callback_data: 'nav_profile' }],
    [{ text: '🏆 Challenges', callback_data: 'nav_challenges' }, { text: '📊 Leaderboard', callback_data: 'nav_leaderboard' }],
    [{ text: '🎁 Rewards', callback_data: 'nav_rewards' }, { text: '📅 Events', callback_data: 'nav_events' }],
    [{ text: '🔗 Referral', callback_data: 'nav_referral' }],
  ];
  if (isAdmin(msg.from.id)) {
    buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  }
  buttons.push([{ text: '❓ Help', callback_data: 'nav_help' }]);

  let welcomeText = '';
  if (isNewUser) {
    welcomeText =
      `👋 <b>Welcome to SkillBridge!</b>\n\n` +
      `Hey ${esc(u.firstName)}! We're glad to have you here.\n\n` +
      `SkillBridge is your gamified learning hub where you:\n\n` +
      `📝 <b>Take daily quizzes</b> — 5 questions each day across different topics\n` +
      `🏆 <b>Complete challenges</b> — hands-on projects to build real skills\n` +
      `⭐ <b>Earn SkillPoints</b> — climb levels and unlock rewards\n` +
      `🏅 <b>Collect badges</b> — show off your achievements\n` +
      `🎓 <b>Win scholarships</b> — earn up to 100% scholarship with your SP\n\n` +
      `Let's get started! Tap a button below 👇\n`;
  } else {
    welcomeText =
      `🎓 <b>Welcome back to SkillBridge</b>\n\n` +
      `${greeting()}, ${u.firstName}!\n` +
      `Ready to level up your skills today?\n\n` +
      `📊 Level: ${lvl.name}\n` +
      `⭐ SkillPoints: ${u.skillPoints}\n` +
      `🔥 Streak: ${u.streak} day${u.streak !== 1 ? 's' : ''}\n` +
      streakText +
      referralText + `\n\n` +
      `Tap a button below to explore.`;
  }

  const logoPath = path.join(__dirname, 'skillbridge_logo_3d.png');
  sendPhoto(msg.chat.id, logoPath, welcomeText, { reply_markup: mainMenuKeyboard(msg.from.id) });
};

handlers['/help'] = (msg) => {
  let text =
    `📖 <b>Help &amp; Commands</b>\n\n` +
    `📚 <b>Learning</b>\n` +
    `  /daily - Today's activities\n` +
    `  /quiz - Browse quizzes\n` +
    `  /challenges - Active challenges\n` +
    `  /submit &lt;id&gt; &lt;url&gt; - Submit solution\n\n` +
    `🎮 <b>Gamification</b>\n` +
    `  /profile - View your profile\n` +
    `  /badges - Your badge collection\n` +
    `  /leaderboard - Top learners\n` +
    `  /referral - Earn by inviting friends\n\n` +
    `📅 <b>Events</b>\n` +
    `  /events - Upcoming events\n\n` +
    `🎁 <b>Rewards</b>\n` +
    `  /rewards - Rewards store\n\n` +
    `🔧 <b>Other</b>\n` +
    `  /start - Home\n` +
    `  /cancel - Exit current action\n` +
    `  /help - This message`;

  if (isAdmin(msg.from.id)) {
    text += `\n\n` +
      `⚙️ <b>Admin</b>\n` +
      `  /admin - Admin panel\n` +
      `  /addquiz - Create quiz\n` +
      `  /addquestion &lt;id&gt; - Add question\n` +
      `  /addchallenge - Create challenge\n` +
      `  /addreward - Create reward\n` +
      `  /addevent - Create event\n` +
      `  /addbadge - Create badge\n` +
      `  /reloadpool - Reload quiz pool from file\n` +
      `  /poolstats - View pool statistics\n` +
      `  /broadcast &lt;msg&gt; - Send to all\n`;
  }

  send(msg.chat.id, text,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
  );
};

handlers['/cancel'] = (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  let cancelled = false;

  if (quizSessions[userId]) {
    delete quizSessions[userId];
    delete sessionTimestamps[userId];
    cancelled = true;
  }
  if (adminFlows[userId]) {
    delete adminFlows[userId];
    delete flowTimestamps[userId];
    cancelled = true;
  }
  if (userFlows[userId]) {
    delete userFlows[userId];
    delete flowTimestamps[userId];
    cancelled = true;
  }

  if (cancelled) {
    send(chatId, '✅ _Action cancelled. Returning to main menu._', {
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏠 Home', callback_data: 'nav_start' }]] })
    });
  } else {
    send(chatId, '_Nothing to cancel. You\'re all clear!_', {
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏠 Home', callback_data: 'nav_start' }]] })
    });
  }
};

// ─── Profile ───
handlers['/profile'] = (msg) => { sendProfile(msg.chat.id, msg.from.id); };
handlers['/nav_profile'] = (msg) => { sendProfile(msg.chat.id, msg.from.id); };

function sendProfile(chatId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  if (!user) return send(chatId, 'Send /start first.');
  const lvl = getLevel(user.xp);
  const next = getNextLevel(user.xp);
  const pct = next ? Math.min(100, Math.round(((user.xp - lvl.xp) / (next.xp - lvl.xp)) * 100)) : 100;
  const rank = db.prepare('SELECT COUNT(*) as c FROM users WHERE skillPoints > ?').get(user.skillPoints).c + 1;
  const badgeCount = db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE userId = ?').get(user.id).c;
  const totalBadges = db.prepare('SELECT COUNT(*) as c FROM badges WHERE isActive = 1').get().c;
  const rankLabel = rank === 1 ? '🥇 #1' : rank === 2 ? '🥈 #2' : rank === 3 ? '🥉 #3' : `#${rank}`;

  const sp = user.skillPoints;
  let scholarship;
  let nextTier;
  let tierPct;
  if (sp >= 5000) {
    scholarship = '🎓 Full Scholarship (100%)';
    nextTier = null;
    tierPct = 100;
  } else if (sp >= 4000) {
    scholarship = '🥈 50% Scholarship';
    nextTier = { label: '100% Scholarship', needed: 5000 };
    tierPct = Math.min(100, Math.round(((sp - 4000) / 1000) * 100));
  } else if (sp >= 3000) {
    scholarship = '🥉 25% Scholarship';
    nextTier = { label: '50% Scholarship', needed: 4000 };
    tierPct = Math.min(100, Math.round(((sp - 3000) / 1000) * 100));
  } else {
    scholarship = null;
    nextTier = { label: '25% Scholarship', needed: 3000 };
    tierPct = Math.min(100, Math.round((sp / 3000) * 100));
  }

  send(chatId,
    `👤 <b>Your Profile</b>\n\n` +
    `${user.firstName}  ·  @${user.username || '—'}\n` +
    `${lvl.name}  ·  Rank ${rankLabel}\n\n` +
    `⭐ SkillPoints: ${sp}\n` +
    `🔥 Streak: ${user.streak} day${user.streak !== 1 ? 's' : ''}\n` +
    `📝 Quizzes: ${user.quizzesCompleted}\n` +
    `🏆 Challenges: ${user.challengesCompleted}\n` +
    `🚀 Projects: ${user.projectsCompleted || user.projectsSubmitted || 0}\n` +
    `🤝 Community: ${user.communityContributions}\n` +
    `🏅 Badges: ${badgeCount}/${totalBadges}\n` +
    `🔗 Referrals: ${user.referralsCount || 0}\n\n` +
    (scholarship
      ? `${scholarship}\n\n`
      : '') +
    `📈 <b>Scholarship Progress</b>\n\n` +
    `${bar(tierPct)} ${tierPct}%\n` +
    (nextTier
      ? `${sp} / ${nextTier.needed} SP → ${nextTier.label}`
      : '🎓 Maximum scholarship achieved!') + `\n\n` +
    `📊 <b>Level Progress</b>\n\n` +
    `${lvl.name} → ${next ? next.name : '👑 MAX'}\n` +
    `${bar(pct)} ${pct}%\n` +
    `${user.xp} / ${next ? next.xp : user.xp} XP  ${progressLabel(pct)}\n`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏅 Badges', callback_data: 'nav_badges' }, { text: '🔗 Referral', callback_data: 'nav_referral' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
  );
}

// ─── Daily ───
handlers['/daily'] = (msg) => { sendDaily(msg.chat.id); };
handlers['/nav_daily'] = (msg) => { sendDaily(msg.chat.id); };

function sendDaily(chatId) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const dayOfWeek = today.getDay();
  const catLabel = CATEGORY_BY_DAY[dayOfWeek] === 'mixed' ? 'Mixed Categories' : CATEGORY_BY_DAY[dayOfWeek];
  const poolCount = db.prepare('SELECT COUNT(*) as c FROM quiz_pool WHERE isActive = 1').get().c;
  const dailyChallenge = db.prepare('SELECT * FROM challenges WHERE isDaily = 1 AND isActive = 1 LIMIT 1').get();

  let text =
    `☀️ <b>Daily Activities</b>\n\n` +
    `${dateStr}\n\n` +
    `📝 <b>Daily Quiz</b> — ${catLabel}\n` +
    `5 questions · 10 SP each\n\n`;

  if (dailyChallenge) {
    text += `🏆 ${dailyChallenge.title}\n` +
      `${dailyChallenge.points} SP\n\n`;
  }

  if (poolCount === 0) {
    text += `⚠️ No questions in pool.\nAdmin: add questions to questions.json and run /reloadpool\n\n`;
  }

  text += `Complete both to maximize your earnings!`;

  const buttons = [];
  if (poolCount > 0) buttons.push([{ text: '📝 Take Quiz', callback_data: 'start_daily_pool_quiz' }]);
  if (dailyChallenge) buttons.push([{ text: '🏆 Take Challenge', callback_data: `view_challenge_${dailyChallenge.id}` }]);
  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);

  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

// ─── Leaderboard ───
handlers['/leaderboard'] = (msg) => { sendLeaderboard(msg.chat.id); };
handlers['/nav_leaderboard'] = (msg) => { sendLeaderboard(msg.chat.id); };

function sendLeaderboard(chatId) {
  const sorted = db.prepare('SELECT * FROM users WHERE isActive = 1 ORDER BY skillPoints DESC LIMIT 10').all();
  if (sorted.length === 0) {
    return send(chatId, `🏆 <b>Leaderboard</b>\n\nNo learners yet.\nBe the first to start your journey!`, {
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🚀 Get Started', callback_data: 'nav_daily' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] })
    });
  }

  let text =
    `🏆 <b>Leaderboard</b>\n\n`;

  sorted.forEach((u, i) => {
    const lvl = getLevel(u.xp);
    const medal = rankEmoji(i);
    text += `${medal}  ${esc(u.firstName)}\n` +
            `      ${lvl.name} · ${u.skillPoints} SP · 🔥 ${u.streak}d\n\n`;
  });

  send(chatId, text, {
    reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏠 Home', callback_data: 'nav_start' }]] })
  });
}

// ─── Rewards ───
handlers['/rewards'] = (msg) => { sendRewards(msg.chat.id, msg.from.id); };
handlers['/nav_rewards'] = (msg) => { sendRewards(msg.chat.id, msg.from.id); };

function sendRewards(chatId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  if (!user) return send(chatId, 'Send /start first.');
  const rewards = db.prepare('SELECT * FROM rewards WHERE isActive = 1').all();

  let text =
    `🎁 <b>Rewards Store</b>\n\n` +
    `💰 Your Balance: ${user.skillPoints} SP\n\n`;

  const buttons = [];
  const row = [];
  rewards.forEach((r, i) => {
    const stockText = r.stock === -1 ? '∞ Available' : `${r.stock} left`;
    const affordable = user.skillPoints >= r.skillPointsCost;
    const status = affordable ? '✅ Available' : '🔒 Locked';
    text += `${r.name}\n` +
      `${r.description}\n` +
      `💰 ${r.skillPointsCost} SP · ${stockText}\n` +
      `${status}\n\n`;
    row.push({ text: `${affordable ? '🎁' : '🔒'} ${r.skillPointsCost} SP`, callback_data: `redeem_${r.id}` });
    if (row.length === 2 || i === rewards.length - 1) {
      buttons.push([...row]);
      row.length = 0;
    }
  });

  if (rewards.length === 0) {
    text += `No rewards available yet.\nCheck back soon!\n`;
  }

  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

// ─── Events ───
handlers['/events'] = (msg) => { sendEvents(msg.chat.id, msg.from.id); };
handlers['/nav_events'] = (msg) => { sendEvents(msg.chat.id, msg.from.id); };

function sendEvents(chatId, userId) {
  const events = db.prepare('SELECT * FROM events WHERE isActive = 1 ORDER BY startsAt ASC').all();
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));

  let text = `📅 <b>Upcoming Events</b>\n\n`;

  if (events.length === 0) {
    text += `No upcoming events. Check back soon!`;
  } else {
    events.forEach(e => {
      const date = new Date(e.startsAt);
      const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const spotsLeft = e.maxAttendees > 0 ? `${e.currentAttendees}/${e.maxAttendees} spots` : 'Unlimited spots';
      const typeIcon = e.type === 'workshop' ? '🔧' : e.type === 'hackathon' ? '💻' : e.type === 'meetup' ? '🤝' : '📅';

      text += `${typeIcon} <b>${esc(e.title)}</b>\n`;
      text += `   📅 ${dateStr}  ·  +${e.skillPointsReward} SP\n`;
      text += `   ${esc(e.description || 'No description')}\n`;
      text += `   👥 ${spotsLeft}\n\n`;
    });
  }

  const buttons = [];
  events.forEach(e => {
    buttons.push([{ text: `${esc(e.title)} (+${e.skillPointsReward} SP)`, callback_data: `view_event_${e.id}` }]);
  });
  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);

  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function handleEventRegistration(chatId, userId, eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return send(chatId, 'Event not found.');

  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  if (!user) return send(chatId, 'Send /start first.');

  const existing = db.prepare('SELECT * FROM event_registrations WHERE userId = ? AND eventId = ?').get(user.id, eventId);
  if (existing) return send(chatId, 'You are already registered for this event.');

  if (event.maxAttendees > 0 && event.currentAttendees >= event.maxAttendees) {
    return send(chatId, 'Sorry, this event is full.');
  }

  db.prepare('INSERT INTO event_registrations (userId, eventId, registeredAt) VALUES (?, ?, datetime(\'now\'))').run(user.id, eventId);
  db.prepare('UPDATE events SET currentAttendees = currentAttendees + 1 WHERE id = ?').run(eventId);

  const date = new Date(event.startsAt);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  send(chatId,
    `✅ <b>Registration Confirmed!</b>\n\n` +
    `📅 ${esc(event.title)}\n` +
    `📆 ${dateStr}\n` +
    `💰 +${event.skillPointsReward} SP after attendance\n\n` +
    `See you there!`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '📅 More Events', callback_data: 'nav_events' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
  );
}

// ─── Challenges ───
handlers['/challenges'] = (msg) => { sendChallenges(msg.chat.id); };
handlers['/nav_challenges'] = (msg) => { sendChallenges(msg.chat.id); };

function sendChallenges(chatId) {
  const challenges = db.prepare('SELECT * FROM challenges WHERE isActive = 1 ORDER BY category, difficulty').all();
  const text = `🏆 <b>Challenges</b> (${challenges.length})\n\nPick a category below:`;

  const categories = [...new Set(challenges.map(c => c.category))];
  const catIcons = {
    'Cybersecurity': '🔒', 'Automation': '🤖', 'Mobile App': '📱',
    'Website': '🌐', 'UX/UI Design': '🎨', 'Video Editing': '🎬', 'Graphics Design': '✏️',
    'AI & Data Science': '🧠', 'Coding': '💻', 'Basic Computer Skills': '🖥️',
    'Data Science': '📈', 'Data Analytics': '📉', 'R': '📐',
    'Frontend': '🎯', 'Backend': '⚙️', 'Python': '🐍', 'DSA': '🧩',
    'Accounting': '💼', 'Digital Marketing': '📣', 'Social Media Management': '📱',
    'Odoo Functional': '🔧', 'Odoo Technical': '🛠️',
    'ERPNext Functional': '📋', 'ERPNext Technical': '🔨',
  };

  const buttons = categories.map(cat => {
    const icon = catIcons[cat] || '📂';
    const count = challenges.filter(c => c.category === cat).length;
    return [{ text: `${icon} ${cat} (${count})`, callback_data: `cat_${cat.replace(/[^a-zA-Z]/g, '')}` }];
  });
  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);

  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function sendChallengesByCategory(chatId, category) {
  const challenges = db.prepare('SELECT * FROM challenges WHERE isActive = ? AND category = ? ORDER BY difficulty').all(1, category);
  if (challenges.length === 0) return send(chatId, 'No challenges in this category.');

  const catIcons = {
    'Cybersecurity': '🔒', 'Automation': '🤖', 'Mobile App': '📱',
    'Website': '🌐', 'UX/UI Design': '🎨', 'Video Editing': '🎬', 'Graphics Design': '✏️',
    'AI & Data Science': '🧠', 'Coding': '💻', 'Basic Computer Skills': '🖥️',
    'Data Science': '📈', 'Data Analytics': '📉', 'R': '📐',
    'Frontend': '🎯', 'Backend': '⚙️', 'Python': '🐍', 'DSA': '🧩',
    'Accounting': '💼', 'Digital Marketing': '📣', 'Social Media Management': '📱',
    'Odoo Functional': '🔧', 'Odoo Technical': '🛠️',
    'ERPNext Functional': '📋', 'ERPNext Technical': '🔨',
  };
  const icon = catIcons[category] || '📂';

  let text = `${icon} <b>${category}</b> (${challenges.length} challenges)\n\n`;
  const buttons = [];
  challenges.forEach(c => {
    const diff = '★'.repeat(c.difficulty) + '☆'.repeat(5 - c.difficulty);
    const shortDesc = esc((c.description || '').split('\n')[0]).slice(0, 80);
    text += `• <b>${esc(c.title)}</b> (${c.points} SP) ${diff}\n  ${shortDesc}...\n\n`;
    buttons.push([{ text: `${c.title} (${c.points} SP)`, callback_data: `view_challenge_${c.id}` }]);
  });
  buttons.push([{ text: '← All Categories', callback_data: 'nav_challenges' }]);
  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);

  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

// ─── Quiz List ───
handlers['/quiz'] = (msg) => { sendQuizList(msg.chat.id); };
handlers['/nav_quiz'] = (msg) => { sendQuizList(msg.chat.id); };

function sendQuizList(chatId) {
  const quizzes = db.prepare('SELECT * FROM quizzes WHERE isActive = 1').all();
  let text =
    `📝 <b>Available Quizzes</b>\n\n`;

  const buttons = [];
  quizzes.forEach((q) => {
    const qCount = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE quizId = ?').get(q.id).c;
    text += `${q.title}\n` +
      `${q.category} · ${qCount} questions\n` +
      `${q.totalPoints} SP\n\n`;
    buttons.push([{ text: q.title, callback_data: `start_quiz_${q.id}` }]);
  });

  buttons.push([{ text: '🏠 Home', callback_data: 'nav_start' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

// ─── Badges ───
handlers['/badges'] = (msg) => { sendBadges(msg.chat.id, msg.from.id); };
handlers['/nav_badges'] = (msg) => { sendBadges(msg.chat.id, msg.from.id); };

function sendBadges(chatId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  if (!user) return send(chatId, 'Send /start first.');
  const allBadges = db.prepare('SELECT * FROM badges WHERE isActive = 1').all();
  const earnedIds = db.prepare('SELECT badgeId FROM user_badges WHERE userId = ?').all(user.id).map(r => r.badgeId);

  let text =
    `🏅 <b>Your Badges</b>\n\n` +
    `Earned: ${earnedIds.length}/${allBadges.length}\n\n`;

  allBadges.forEach((b) => {
    const earned = earnedIds.includes(b.id);
    const icon = earned ? '✅' : '⬜';
    text += `${icon} ${b.icon || '🏅'} ${b.name}` + (earned ? ` — Earned!` : '') + `\n`;
    if (!earned) text += `   ${b.description}\n`;
    text += `\n`;
  });

  if (allBadges.length === 0) {
    text += `No badges available yet.\nComplete challenges to earn them!`;
  }

  send(chatId, text, {
    reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏆 Challenges', callback_data: 'nav_challenges' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] })
  });
}

// ─── Referral ───
handlers['/referral'] = (msg) => { sendReferral(msg.chat.id, msg.from.id); };
handlers['/nav_referral'] = (msg) => { sendReferral(msg.chat.id, msg.from.id); };

function sendReferral(chatId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  if (!user) return send(chatId, 'Send /start first.');
  const code = user.referralCode || `ref_${userId}`;
  const refLink = `https://t.me/skillbridge_hub_bot?start=${code}`;
  const groupLink = `https://t.me/skillbridgeinstituteoftech`;
  const shareText = `Join me on SkillBridge! 🎓\n\n🤖 Start the bot: ${refLink}\n🌐 Join our community: ${groupLink}\n\nEarn SkillPoints, complete challenges & win scholarships!`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareText)}`;

  send(chatId,
    `🔗 <b>Referral Program</b>\n\n` +
    `Share your link and earn 25 SP per friend who joins!\n\n` +
    `📊 Your Referrals: ${user.referralsCount || 0}\n` +
    `💰 Earned: ${(user.referralsCount || 0) * 25} SP\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🤖 <b>Bot Link (for referral tracking):</b>\n` +
    `<code>${refLink}</code>\n\n` +
    `🌐 <b>Community Group:</b>\n` +
    `<code>${groupLink}</code>`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '📤 Share Referral', url: shareUrl }], [{ text: '🌐 Join Community', url: groupLink }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
  );
}

// ─── Submit Challenge ───
handlers['/submit'] = (msg) => {
  const parts = msg.text.split(' ');
  if (parts.length < 3) {
    return send(msg.chat.id,
      `Submit Solution\n\n` +
      `Usage: /submit &lt;challenge_id&gt; &lt;url&gt;\n\n` +
      `Example:\n/submit 1 https://github.com/user/project`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'View Challenges', callback_data: 'nav_challenges' }], [{ text: 'Home', callback_data: 'nav_start' }]] }) }
    );
  }

  const challengeId = parseInt(parts[1]);
  const solutionUrl = parts.slice(2).join(' ');
  const user = getOrCreateUser(msg.from.id, msg.from.first_name, msg.from.username);
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId);

  if (!challenge) return send(msg.chat.id, 'Challenge not found.');

  const existing = db.prepare('SELECT * FROM challenge_submissions WHERE userId = ? AND challengeId = ?').get(user.id, challengeId);
  if (existing) return send(msg.chat.id, 'You already submitted this challenge.');

  db.prepare('INSERT INTO challenge_submissions (userId, challengeId, solution, githubUrl, completed, pointsAwarded, createdAt) VALUES (?, ?, ?, ?, 0, 0, datetime(\'now\'))').run(user.id, challengeId, solutionUrl, solutionUrl);

  send(msg.chat.id,
    `Submission Received\n\n` +
    `Challenge: ${challenge.title}\n` +
    `Points: ${challenge.points} SP (pending review)\n\n` +
    `Your submission is pending admin review.\n` +
    `You will be notified once it is approved.`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'More Challenges', callback_data: 'nav_challenges' }], [{ text: 'Home', callback_data: 'nav_start' }]] }) }
  );
};

// ═══════════════════════════════════════════
//  ADMIN COMMANDS
// ═══════════════════════════════════════════

function cancelFlow(chatId, userId) {
  delete adminFlows[userId];
  delete flowTimestamps[userId];
  send(chatId, '_Action cancelled._', { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏠 Home', callback_data: 'nav_start' }]] }) });
}

handlers['/admin'] = (msg) => { sendAdminPanel(msg.chat.id, msg.from.id); };
handlers['/nav_admin'] = (msg) => { sendAdminPanel(msg.chat.id, msg.from.id); };

function sendAdminPanel(chatId, userId) {
  if (!isAdmin(userId)) return send(chatId, 'Admin only.');
  delete adminFlows[userId];
  delete flowTimestamps[userId];

  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalQuizzes = db.prepare('SELECT COUNT(*) as c FROM quizzes').get().c;
  const totalChallenges = db.prepare('SELECT COUNT(*) as c FROM challenges').get().c;
  const totalRewards = db.prepare('SELECT COUNT(*) as c FROM rewards').get().c;
  const totalEvents = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const totalBadges = db.prepare('SELECT COUNT(*) as c FROM badges').get().c;
  const pendingSubs = db.prepare('SELECT COUNT(*) as c FROM challenge_submissions WHERE completed = 0').get().c;
  let pendingRedemptions = 0;
  try { pendingRedemptions = db.prepare("SELECT COUNT(*) as c FROM reward_redemptions WHERE status = 'pending'").get().c; } catch (_) {}

  send(chatId,
    `🛠️ <b>Admin Panel</b>\n\n` +
    `👥 Users: ${totalUsers}\n` +
    `📝 Quizzes: ${totalQuizzes}\n` +
    `🏆 Challenges: ${totalChallenges}\n` +
    `🎁 Rewards: ${totalRewards}\n` +
    `📅 Events: ${totalEvents}\n` +
    `🏅 Badges: ${totalBadges}\n` +
    `⏳ Pending Reviews: ${pendingSubs}\n` +
    `🔄 Pending Redemptions: ${pendingRedemptions}\n`,
    { reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '📝 Quizzes', callback_data: 'admin_quizzes' }, { text: '🏆 Challenges', callback_data: 'admin_challenges' }],
          [{ text: '🎁 Rewards', callback_data: 'admin_rewards' }, { text: '🏅 Badges', callback_data: 'admin_badges' }],
          [{ text: '📅 Events', callback_data: 'admin_events' }, { text: '👥 Users', callback_data: 'admin_users' }],
          [{ text: '⏳ Reviews', callback_data: 'admin_submissions' }, { text: '🔄 Redemptions', callback_data: 'admin_redemptions' }],
          [{ text: '📋 Quiz Pool', callback_data: 'admin_quizpool' }, { text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
          [{ text: '🏠 Home', callback_data: 'nav_start' }],
        ]
      })
    }
  );
}

// ─── Admin CRUD ───
handlers['/addquiz'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  adminFlows[msg.from.id] = { step: 'addquiz_title', data: {} };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `📝 Add Quiz\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/5: Quiz title:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

handlers['/addquestion'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  const parts = msg.text.split(' ');
  const quizId = parseInt(parts[1]);
  if (!quizId) {
    return send(msg.chat.id, 'Usage: /addquestion <quiz_id>',
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Quizzes', callback_data: 'admin_quizzes' }]] }) });
  }
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
  if (!quiz) return send(msg.chat.id, 'Quiz not found.');
  adminFlows[msg.from.id] = { step: 'addquestion_text', data: { quizId, quizTitle: quiz.title } };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `📝 Add Question to: ${quiz.title}\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/4: Enter the question:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

handlers['/reloadpool'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  try {
    const result = syncPoolFromFile();
    const stats = getPoolStats();
    send(msg.chat.id,
      `✅ <b>Quiz Pool Reloaded</b>\n\n` +
      `➕ Added: ${result.added}\n` +
      `🔄 Updated: ${result.updated}\n\n` +
      `📊 <b>Pool Stats</b>\n` +
      `Total: ${stats.total} questions\n` +
      `Used: ${stats.totalUsed}\n` +
      `Remaining: ${stats.remaining}\n` +
      `Days covered: ~${stats.daysCovered} days\n\n` +
      stats.byCategory.map(c => `  ${c.category}: ${c.c}`).join('\n'),
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
    );
  } catch (err) {
    send(msg.chat.id, `❌ Error reloading pool: ${err.message}`);
  }
};

handlers['/poolstats'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  try {
    const stats = getPoolStats();
    send(msg.chat.id,
      `📊 <b>Quiz Pool Stats</b>\n\n` +
      `📝 Total questions: ${stats.total}\n` +
      `✅ Used (unique): ${stats.totalUsed}\n` +
      `⏳ Remaining: ${stats.remaining}\n` +
      `📅 Days covered: ~${stats.daysCovered}\n\n` +
      `<b>By Category:</b>\n` +
      (stats.byCategory.length > 0 ? stats.byCategory.map(c => `  ${c.category}: ${c.c}`).join('\n') : '  No questions yet'),
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🔄 Reload Pool', callback_data: 'admin_reloadpool' }], [{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
    );
  } catch (err) {
    send(msg.chat.id, `❌ Error: ${err.message}`);
  }
};

handlers['/addchallenge'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  adminFlows[msg.from.id] = { step: 'addchallenge_title', data: {} };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `🏆 Add Challenge\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/6: Challenge title:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

handlers['/addreward'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  adminFlows[msg.from.id] = { step: 'addreward_name', data: {} };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `🎁 Add Reward\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/5: Reward name:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

handlers['/addevent'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  adminFlows[msg.from.id] = { step: 'addevent_title', data: {} };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `📅 Add Event\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/6: Event title:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

handlers['/addbadge'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  adminFlows[msg.from.id] = { step: 'addbadge_name', data: {} };
  flowTimestamps[msg.from.id] = Date.now();
  send(msg.chat.id,
    `🏅 Add Badge\n\n` +
    `Send /cancel to abort.\n\n` +
    `Step 1/5: Badge name:`,
    { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
  );
};

async function broadcastWithRateLimit(chatId, text) {
  const allUsers = db.prepare('SELECT telegramId FROM users WHERE isActive = 1').all();
  const BATCH_SIZE = 25;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < allUsers.length; i += BATCH_SIZE) {
    if (shutdownRequested) break;
    const batch = allUsers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(u =>
      send(u.telegramId, `📢 <b>Announcement</b>\n\n${text}`).then(() => sent++).catch(() => failed++)
    ));
    if (i + BATCH_SIZE < allUsers.length) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }
  send(chatId, `Broadcast delivered: ${sent}/${allUsers.length} users (${failed} failed).`);
}

handlers['/broadcast'] = (msg) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, 'Admin only.');
  const text = msg.text.replace('/broadcast', '').trim();
  if (!text) return send(msg.chat.id, 'Usage: /broadcast <message>');
  send(msg.chat.id, 'Broadcasting...');
  broadcastWithRateLimit(msg.chat.id, text);
};

handlers['/listquizzes'] = (msg) => { if (isAdmin(msg.from.id)) sendQuizListAdmin(msg.chat.id); };
handlers['/listchallenges'] = (msg) => { if (isAdmin(msg.from.id)) sendChallengeListAdmin(msg.chat.id); };
handlers['/listrewards'] = (msg) => { if (isAdmin(msg.from.id)) sendRewardListAdmin(msg.chat.id); };
handlers['/listevents'] = (msg) => { if (isAdmin(msg.from.id)) sendEventListAdmin(msg.chat.id); };
handlers['/listbadges'] = (msg) => { if (isAdmin(msg.from.id)) sendBadgeListAdmin(msg.chat.id); };

function sendQuizListAdmin(chatId) {
  const quizzes = db.prepare('SELECT * FROM quizzes').all();
  const counts = db.prepare('SELECT quizId, COUNT(*) as c FROM quiz_questions GROUP BY quizId').all();
  const countMap = {};
  counts.forEach(r => { countMap[r.quizId] = r.c; });
  let text = `📝 <b>Quizzes</b>\n\n`;
  const buttons = [];
  quizzes.forEach(q => {
    const status = q.isActive ? '🟢' : '🔴';
    const daily = q.isDaily ? ' · 📅 Daily' : '';
    text += `${status} #${q.id} ${esc(q.title)}\n   ${countMap[q.id] || 0} questions · ${q.totalPoints} SP${daily}\n\n`;
    buttons.push([{ text: `${q.isActive ? '🔴 Deactivate' : '🟢 Activate'} #${q.id}`, callback_data: `admin_togglequiz_${q.id}` }, { text: `✏️ Edit #${q.id}`, callback_data: `admin_editquiz_${q.id}` }]);
    buttons.push([{ text: `${q.isDaily ? '❌ Unset Daily' : '📅 Set Daily'} #${q.id}`, callback_data: q.isDaily ? `admin_unsetdailyquiz_${q.id}` : `admin_setdailyquiz_${q.id}` }, { text: `❓ Questions (${countMap[q.id] || 0}) #${q.id}`, callback_data: `admin_listquestions_${q.id}` }]);
    buttons.push([{ text: `🗑 Delete #${q.id}`, callback_data: `admin_delquiz_${q.id}` }]);
  });
  if (quizzes.length === 0) text += `No quizzes yet.\n`;
  buttons.push([{ text: '➕ Add Quiz', callback_data: 'admin_addquiz' }]);
  buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function sendChallengeListAdmin(chatId) {
  const items = db.prepare('SELECT * FROM challenges').all();
  let text = `🏆 <b>Challenges</b>\n\n`;
  const buttons = [];
  items.forEach(c => {
    const status = c.isActive ? '🟢' : '🔴';
    const daily = c.isDaily ? ' · 📅 Daily' : '';
    text += `${status} #${c.id} ${esc(c.title)}\n   💰 ${c.points} SP · 📊 ${c.difficulty}/5${daily}\n\n`;
    buttons.push([{ text: `${c.isActive ? '🔴 Deactivate' : '🟢 Activate'} #${c.id}`, callback_data: `admin_togglechallenge_${c.id}` }, { text: `✏️ Edit #${c.id}`, callback_data: `admin_editchallenge_${c.id}` }]);
    buttons.push([{ text: `${c.isDaily ? '❌ Unset Daily' : '📅 Set Daily'} #${c.id}`, callback_data: c.isDaily ? `admin_unsetdailychallenge_${c.id}` : `admin_setdailychallenge_${c.id}` }]);
    buttons.push([{ text: `🗑 Delete #${c.id}`, callback_data: `admin_delchallenge_${c.id}` }]);
  });
  if (items.length === 0) text += `No challenges yet.\n`;
  buttons.push([{ text: '➕ Add Challenge', callback_data: 'admin_addchallenge' }]);
  buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function sendRewardListAdmin(chatId) {
  const items = db.prepare('SELECT * FROM rewards').all();
  let text = `🎁 <b>Rewards</b>\n\n`;
  const buttons = [];
  items.forEach(r => {
    const status = r.isActive ? '🟢' : '🔴';
    const stock = r.stock === -1 ? '∞' : `${r.stock}`;
    text += `${status} #${r.id} ${esc(r.name)}\n   💰 ${r.skillPointsCost} SP · 📦 Stock: ${stock}\n\n`;
    buttons.push([{ text: `${r.isActive ? '🔴 Deactivate' : '🟢 Activate'} #${r.id}`, callback_data: `admin_togglereward_${r.id}` }, { text: `✏️ Edit #${r.id}`, callback_data: `admin_editreward_${r.id}` }]);
    buttons.push([{ text: `🗑 Delete #${r.id}`, callback_data: `admin_delreward_${r.id}` }]);
  });
  if (items.length === 0) text += `No rewards yet.\n`;
  buttons.push([{ text: '➕ Add Reward', callback_data: 'admin_addreward' }]);
  buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function sendBadgeListAdmin(chatId) {
  const items = db.prepare('SELECT * FROM badges').all();
  let text = `🏅 <b>Badges</b>\n\n`;
  const buttons = [];
  items.forEach(b => {
    const status = b.isActive ? '🟢' : '🔴';
    text += `${status} #${b.id} ${b.icon || '🏅'} ${esc(b.name)}\n   📋 ${esc(b.requirement)} · +${b.skillPointsReward} SP\n\n`;
    buttons.push([{ text: `${b.isActive ? '🔴 Deactivate' : '🟢 Activate'} #${b.id}`, callback_data: `admin_togglebadge_${b.id}` }, { text: `✏️ Edit #${b.id}`, callback_data: `admin_editbadge_${b.id}` }]);
    buttons.push([{ text: `🗑 Delete #${b.id}`, callback_data: `admin_delbadge_${b.id}` }]);
  });
  if (items.length === 0) text += `No badges yet.\n`;
  buttons.push([{ text: '➕ Add Badge', callback_data: 'admin_addbadge' }]);
  buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

function sendEventListAdmin(chatId) {
  const items = db.prepare('SELECT * FROM events').all();
  let text = `📅 <b>Events</b>\n\n`;
  const buttons = [];
  items.forEach(e => {
    const status = e.isActive ? '🟢' : '🔴';
    const date = new Date(e.startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    text += `${status} #${e.id} ${esc(e.title)}\n   📅 ${date} · +${e.skillPointsReward} SP\n\n`;
    buttons.push([{ text: `${e.isActive ? '🔴 Deactivate' : '🟢 Activate'} #${e.id}`, callback_data: `admin_toggleevent_${e.id}` }]);
    buttons.push([{ text: `🗑 Delete #${e.id}`, callback_data: `admin_delevent_${e.id}` }]);
  });
  if (items.length === 0) text += `No events yet.\n`;
  buttons.push([{ text: '➕ Add Event', callback_data: 'admin_addevent' }]);
  buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
  send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
}

// ─── Admin Text Input Handler ───
function handleAdminInput(msg) {
  const userId = msg.from.id;
  const flow = adminFlows[userId];
  if (!flow) return false;
  if (!isAdmin(userId)) { delete adminFlows[userId]; delete flowTimestamps[userId]; return false; }

  const text = msg.text || '';
  if (text === '/cancel' || text === '/admin') {
    cancelFlow(msg.chat.id, userId);
    if (text === '/admin') sendAdminPanel(msg.chat.id, userId);
    return true;
  }

  const sendQ = (chatId, text, extra) => send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }), ...extra });

  switch (flow.step) {
    case 'addquiz_title':
      flow.data.title = text; flow.step = 'addquiz_desc';
      sendQ(msg.chat.id, `Title: ${esc(text)}\n\nStep 2/5: Description:`);
      return true;
    case 'addquiz_desc':
      flow.data.description = text; flow.step = 'addquiz_category';
      sendQ(msg.chat.id, `Description saved.\n\nStep 3/5: Category (Python, Full-Stack, AI, UI/UX, Data Science):`);
      return true;
    case 'addquiz_category':
      flow.data.category = text; flow.step = 'addquiz_points';
      sendQ(msg.chat.id, `Category: ${esc(text)}\n\nStep 4/5: Total points (e.g. 50):`);
      return true;
    case 'addquiz_points':
      flow.data.totalPoints = parseInt(text);
      if (isNaN(flow.data.totalPoints) || flow.data.totalPoints <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      flow.step = 'addquiz_daily';
      sendQ(msg.chat.id, `Points: ${flow.data.totalPoints}\n\nStep 5/5: Daily quiz? (yes/no):`);
      return true;
    case 'addquiz_daily':
      flow.data.isDaily = text.toLowerCase().startsWith('y') ? 1 : 0;
      const r = db.prepare('INSERT INTO quizzes (title, description, category, timeLimitSeconds, totalPoints, isActive, isDaily) VALUES (?, ?, ?, 120, ?, 1, ?)').run(flow.data.title, flow.data.description, flow.data.category, flow.data.totalPoints, flow.data.isDaily);
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      send(msg.chat.id,
        `✅ <b>Quiz Created (ID: ${r.lastInsertRowid})</b>\n\n` +
        `${flow.data.title}\n` +
        `${flow.data.category} · ${flow.data.totalPoints} SP${flow.data.isDaily ? ' · Daily' : ''}\n\n` +
        `Use /addquestion ${r.lastInsertRowid} to add questions.`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Add Question', callback_data: `admin_addq_${r.lastInsertRowid}` }], [{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    case 'addquestion_text':
      flow.data.questionText = text; flow.step = 'addquestion_options';
      sendQ(msg.chat.id, `Question saved.\n\nStep 2/4: 4 options (comma-separated):\nA, B, C, D`);
      return true;
    case 'addquestion_options':
      const opts = text.split(',').map(o => o.trim());
      if (opts.length !== 4) return sendQ(msg.chat.id, 'Enter exactly 4 options separated by commas.');
      flow.data.options = opts.join(','); flow.step = 'addquestion_correct';
      sendQ(msg.chat.id, `Options saved.\n\nStep 3/4: Correct answer? (1, 2, 3, or 4):`);
      return true;
    case 'addquestion_correct':
      const ci = parseInt(text) - 1;
      if (isNaN(ci) || ci < 0 || ci > 3) return sendQ(msg.chat.id, 'Enter 1, 2, 3, or 4.');
      flow.data.correctOptionIndex = ci; flow.step = 'addquestion_explain';
      sendQ(msg.chat.id, `Correct: ${flow.data.options.split(',')[ci]}\n\nStep 4/4: Explanation:`);
      return true;
    case 'addquestion_explain':
      flow.data.explanation = text;
      const qOrder = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE quizId = ?').get(flow.data.quizId).c + 1;
      const pts = Math.round(db.prepare('SELECT totalPoints FROM quizzes WHERE id = ?').get(flow.data.quizId).totalPoints / Math.max(qOrder, 1));
      db.prepare('INSERT INTO quiz_questions (questionText, options, correctOptionIndex, explanation, points, "order", quizId) VALUES (?, ?, ?, ?, ?, ?, ?)').run(flow.data.questionText, flow.data.options, flow.data.correctOptionIndex, flow.data.explanation, pts, qOrder, flow.data.quizId);
      const qCount = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE quizId = ?').get(flow.data.quizId).c;
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      send(msg.chat.id,
        `✅ <b>Question Added (${qCount} total)</b>\n\n` +
        `${flow.data.questionText}\n\n` +
        `Correct: ${flow.data.options.split(',')[flow.data.correctOptionIndex]}`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Add Another', callback_data: `admin_addq_${flow.data.quizId}` }], [{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    case 'addchallenge_title':
      flow.data.title = text; flow.step = 'addchallenge_desc';
      sendQ(msg.chat.id, `Title: ${esc(text)}\n\nStep 2/6: Description:`);
      return true;
    case 'addchallenge_desc':
      flow.data.description = text; flow.step = 'addchallenge_category';
      sendQ(msg.chat.id, `Description saved.\n\nStep 3/6: Category (Python, Full-Stack, AI, UI/UX, Data Science):`);
      return true;
    case 'addchallenge_category':
      flow.data.category = text; flow.step = 'addchallenge_points';
      sendQ(msg.chat.id, `Category: ${esc(text)}\n\nStep 4/6: Points (e.g. 200):`);
      return true;
    case 'addchallenge_points':
      flow.data.points = parseInt(text);
      if (isNaN(flow.data.points) || flow.data.points <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      flow.step = 'addchallenge_difficulty';
      sendQ(msg.chat.id, `Points: ${flow.data.points}\n\nStep 5/6: Difficulty (1-5):`);
      return true;
    case 'addchallenge_difficulty':
      flow.data.difficulty = parseInt(text);
      if (isNaN(flow.data.difficulty) || flow.data.difficulty < 1 || flow.data.difficulty > 5) return sendQ(msg.chat.id, 'Enter 1-5.');
      flow.step = 'addchallenge_frequency';
      sendQ(msg.chat.id, `Difficulty: ${flow.data.difficulty}/5\n\nStep 6/6: Frequency:\n▸ daily — Daily challenge\n▸ weekly — Weekly challenge\n▸ monthly — Monthly challenge\n▸ none — Not recurring`);
      return true;
    case 'addchallenge_frequency':
      const freq = text.toLowerCase().trim();
      let isDaily = 0, isWeekly = 0, isMonthly = 0;
      if (freq === 'daily') isDaily = 1;
      else if (freq === 'weekly') isWeekly = 1;
      else if (freq === 'monthly') isMonthly = 1;
      const cr = db.prepare('INSERT INTO challenges (title, description, category, points, difficulty, isActive, isDaily, isWeekly, isMonthly) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(flow.data.title, flow.data.description, flow.data.category, flow.data.points, flow.data.difficulty, isDaily, isWeekly, isMonthly);
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      const freqLabel = isDaily ? ' · Daily' : isWeekly ? ' · Weekly' : isMonthly ? ' · Monthly' : '';
      send(msg.chat.id,
        `✅ <b>Challenge Created (ID: ${cr.lastInsertRowid})</b>\n\n` +
        `${flow.data.title}\n` +
        `${flow.data.category} · ${flow.data.points} SP · ${flow.data.difficulty}/5${freqLabel}`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    case 'addreward_name':
      flow.data.name = text; flow.step = 'addreward_desc';
      sendQ(msg.chat.id, `Name: ${esc(text)}\n\nStep 2/5: Description:`);
      return true;
    case 'addreward_desc':
      flow.data.description = text; flow.step = 'addreward_cost';
      sendQ(msg.chat.id, `Description saved.\n\nStep 3/5: Cost in SP (e.g. 500):`);
      return true;
    case 'addreward_cost':
      flow.data.cost = parseInt(text);
      if (isNaN(flow.data.cost) || flow.data.cost <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      flow.step = 'addreward_stock';
      sendQ(msg.chat.id, `Cost: ${flow.data.cost} SP\n\nStep 4/5: Stock (-1 for unlimited):`);
      return true;
    case 'addreward_stock':
      flow.data.stock = parseInt(text);
      if (isNaN(flow.data.stock)) return sendQ(msg.chat.id, 'Enter a valid number.');
      flow.step = 'addreward_category';
      sendQ(msg.chat.id, `Stock: ${flow.data.stock === -1 ? 'unlimited' : flow.data.stock}\n\nStep 5/5: Category (course_discount, workshop, mentorship, career, merchandise):`);
      return true;
    case 'addreward_category':
      flow.data.category = text;
      const rr = db.prepare('INSERT INTO rewards (name, description, skillPointsCost, stock, category, isActive) VALUES (?, ?, ?, ?, ?, 1)').run(flow.data.name, flow.data.description, flow.data.cost, flow.data.stock, flow.data.category);
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      send(msg.chat.id,
        `✅ <b>Reward Created (ID: ${rr.lastInsertRowid})</b>\n\n` +
        `${flow.data.name}\n` +
        `${flow.data.cost} SP · Stock: ${flow.data.stock === -1 ? '∞' : flow.data.stock}`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    case 'addevent_title':
      flow.data.title = text; flow.step = 'addevent_desc';
      sendQ(msg.chat.id, `Title: ${esc(text)}\n\nStep 2/6: Description:`);
      return true;
    case 'addevent_desc':
      flow.data.description = text; flow.step = 'addevent_type';
      sendQ(msg.chat.id, `Description saved.\n\nStep 3/6: Type (workshop, hackathon, meetup, demo_day):`);
      return true;
    case 'addevent_type':
      flow.data.type = text.toLowerCase(); flow.step = 'addevent_date';
      sendQ(msg.chat.id, `Type: ${esc(text)}\n\nStep 4/6: Date (YYYY-MM-DD):`);
      return true;
    case 'addevent_date':
      if (isNaN(new Date(text).getTime())) return sendQ(msg.chat.id, 'Invalid date. Use YYYY-MM-DD.');
      flow.data.startsAt = text + ' 10:00:00'; flow.step = 'addevent_sp';
      sendQ(msg.chat.id, `Date: ${text}\n\nStep 5/6: SP reward (e.g. 50):`);
      return true;
    case 'addevent_sp':
      flow.data.sp = parseInt(text);
      if (isNaN(flow.data.sp) || flow.data.sp <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      flow.step = 'addevent_max';
      sendQ(msg.chat.id, `SP: ${flow.data.sp}\n\nStep 6/6: Max attendees (0 for unlimited):`);
      return true;
    case 'addevent_max':
      flow.data.max = parseInt(text);
      if (isNaN(flow.data.max)) return sendQ(msg.chat.id, 'Enter a valid number.');
      const er = db.prepare('INSERT INTO events (title, description, type, startsAt, skillPointsReward, isActive, maxAttendees, currentAttendees) VALUES (?, ?, ?, ?, ?, 1, ?, 0)').run(flow.data.title, flow.data.description, flow.data.type, flow.data.startsAt, flow.data.sp, flow.data.max);
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      send(msg.chat.id,
        `✅ <b>Event Created (ID: ${er.lastInsertRowid})</b>\n\n` +
        `${flow.data.title}\n` +
        `${flow.data.type} · ${flow.data.startsAt} · ${flow.data.sp} SP`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    case 'addbadge_name':
      flow.data.name = text; flow.step = 'addbadge_icon';
      sendQ(msg.chat.id, `Name: ${esc(text)}\n\nStep 2/5: Icon (emoji):`);
      return true;
    case 'addbadge_icon':
      flow.data.icon = text.trim(); flow.step = 'addbadge_desc';
      sendQ(msg.chat.id, `Icon saved.\n\nStep 3/5: Description:`);
      return true;
    case 'addbadge_desc':
      flow.data.description = text; flow.step = 'addbadge_requirement';
      sendQ(msg.chat.id, `Description saved.\n\nStep 4/5: Requirement code:\n\nExamples:\n▸ python_5 — 5 Python challenges\n▸ fullstack_10 — 10 challenges\n▸ ai_5 — 5 AI challenges\n▸ streak_30 — 30-day streak\n▸ projects_3 — 3 projects\n▸ hackathon_win — Win hackathon`);
      return true;
    case 'addbadge_requirement':
      flow.data.requirement = text; flow.step = 'addbadge_sp';
      sendQ(msg.chat.id, `Requirement: ${esc(text)}\n\nStep 5/5: SP reward (e.g. 50):`);
      return true;
    case 'addbadge_sp':
      flow.data.sp = parseInt(text);
      if (isNaN(flow.data.sp) || flow.data.sp <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      const br = db.prepare('INSERT INTO badges (name, icon, description, requirement, skillPointsReward, isActive) VALUES (?, ?, ?, ?, ?, 1)').run(flow.data.name, flow.data.icon, flow.data.description, flow.data.requirement, flow.data.sp);
      delete adminFlows[userId];
      delete flowTimestamps[userId];
      send(msg.chat.id,
        `✅ <b>Badge Created (ID: ${br.lastInsertRowid})</b>\n\n` +
        `${flow.data.icon} ${flow.data.name}\n` +
        `${flow.data.requirement} · +${flow.data.sp} SP`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
      return true;

    // ── Edit Quiz Flows ──
    case 'editquiz_title':
      db.prepare('UPDATE quizzes SET title = ? WHERE id = ?').run(text, flow.data.quizId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Quiz #${flow.data.quizId} title updated.`);
      return handlers['admin_quizzes'] ? (sendQuizListAdmin(msg.chat.id), true) : true;
    case 'editquiz_description':
      db.prepare('UPDATE quizzes SET description = ? WHERE id = ?').run(text, flow.data.quizId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Quiz #${flow.data.quizId} description updated.`);
      return sendQuizListAdmin(msg.chat.id), true;
    case 'editquiz_category':
      db.prepare('UPDATE quizzes SET category = ? WHERE id = ?').run(text, flow.data.quizId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Quiz #${flow.data.quizId} category updated.`);
      return sendQuizListAdmin(msg.chat.id), true;
    case 'editquiz_totalPoints':
      const tp = parseInt(text);
      if (isNaN(tp) || tp <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      db.prepare('UPDATE quizzes SET totalPoints = ? WHERE id = ?').run(tp, flow.data.quizId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Quiz #${flow.data.quizId} points updated to ${tp}.`);
      return sendQuizListAdmin(msg.chat.id), true;

    // ── Edit Challenge Flows ──
    case 'editchallenge_title':
      db.prepare('UPDATE challenges SET title = ? WHERE id = ?').run(text, flow.data.challengeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Challenge #${flow.data.challengeId} title updated.`);
      return sendChallengeListAdmin(msg.chat.id), true;
    case 'editchallenge_description':
      db.prepare('UPDATE challenges SET description = ? WHERE id = ?').run(text, flow.data.challengeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Challenge #${flow.data.challengeId} description updated.`);
      return sendChallengeListAdmin(msg.chat.id), true;
    case 'editchallenge_category':
      db.prepare('UPDATE challenges SET category = ? WHERE id = ?').run(text, flow.data.challengeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Challenge #${flow.data.challengeId} category updated.`);
      return sendChallengeListAdmin(msg.chat.id), true;
    case 'editchallenge_points':
      const cp = parseInt(text);
      if (isNaN(cp) || cp <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      db.prepare('UPDATE challenges SET points = ? WHERE id = ?').run(cp, flow.data.challengeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Challenge #${flow.data.challengeId} points updated to ${cp}.`);
      return sendChallengeListAdmin(msg.chat.id), true;
    case 'editchallenge_difficulty':
      const cd = parseInt(text);
      if (isNaN(cd) || cd < 1 || cd > 5) return sendQ(msg.chat.id, 'Enter 1-5.');
      db.prepare('UPDATE challenges SET difficulty = ? WHERE id = ?').run(cd, flow.data.challengeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Challenge #${flow.data.challengeId} difficulty updated to ${cd}.`);
      return sendChallengeListAdmin(msg.chat.id), true;

    // ── Edit Reward Flows ──
    case 'editreward_name':
      db.prepare('UPDATE rewards SET name = ? WHERE id = ?').run(text, flow.data.rewardId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Reward #${flow.data.rewardId} name updated.`);
      return sendRewardListAdmin(msg.chat.id), true;
    case 'editreward_description':
      db.prepare('UPDATE rewards SET description = ? WHERE id = ?').run(text, flow.data.rewardId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Reward #${flow.data.rewardId} description updated.`);
      return sendRewardListAdmin(msg.chat.id), true;
    case 'editreward_skillPointsCost':
      const rc = parseInt(text);
      if (isNaN(rc) || rc <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      db.prepare('UPDATE rewards SET skillPointsCost = ? WHERE id = ?').run(rc, flow.data.rewardId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Reward #${flow.data.rewardId} cost updated to ${rc} SP.`);
      return sendRewardListAdmin(msg.chat.id), true;
    case 'editreward_stock':
      const rs = parseInt(text);
      if (isNaN(rs)) return sendQ(msg.chat.id, 'Enter a valid number (-1 for unlimited).');
      db.prepare('UPDATE rewards SET stock = ? WHERE id = ?').run(rs, flow.data.rewardId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Reward #${flow.data.rewardId} stock updated to ${rs === -1 ? '∞' : rs}.`);
      return sendRewardListAdmin(msg.chat.id), true;
    case 'editreward_category':
      db.prepare('UPDATE rewards SET category = ? WHERE id = ?').run(text, flow.data.rewardId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Reward #${flow.data.rewardId} category updated.`);
      return sendRewardListAdmin(msg.chat.id), true;

    // ── Edit Badge Flows ──
    case 'editbadge_name':
      db.prepare('UPDATE badges SET name = ? WHERE id = ?').run(text, flow.data.badgeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Badge #${flow.data.badgeId} name updated.`);
      return sendBadgeListAdmin(msg.chat.id), true;
    case 'editbadge_icon':
      db.prepare('UPDATE badges SET icon = ? WHERE id = ?').run(text.trim(), flow.data.badgeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Badge #${flow.data.badgeId} icon updated.`);
      return sendBadgeListAdmin(msg.chat.id), true;
    case 'editbadge_description':
      db.prepare('UPDATE badges SET description = ? WHERE id = ?').run(text, flow.data.badgeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Badge #${flow.data.badgeId} description updated.`);
      return sendBadgeListAdmin(msg.chat.id), true;
    case 'editbadge_requirement':
      db.prepare('UPDATE badges SET requirement = ? WHERE id = ?').run(text, flow.data.badgeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Badge #${flow.data.badgeId} requirement updated.`);
      return sendBadgeListAdmin(msg.chat.id), true;
    case 'editbadge_skillPointsReward':
      const bs = parseInt(text);
      if (isNaN(bs) || bs <= 0) return sendQ(msg.chat.id, 'Enter a valid number.');
      db.prepare('UPDATE badges SET skillPointsReward = ? WHERE id = ?').run(bs, flow.data.badgeId);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Badge #${flow.data.badgeId} SP reward updated to ${bs}.`);
      return sendBadgeListAdmin(msg.chat.id), true;

    // ── Admin SP Adjust Flows ──
    case 'admin_addsp_amount':
      const addAmt = parseInt(text);
      if (isNaN(addAmt) || addAmt <= 0) return sendQ(msg.chat.id, 'Enter a valid positive number.');
      const addU = db.prepare('SELECT * FROM users WHERE id = ?').get(flow.data.userId);
      if (!addU) { delete adminFlows[userId]; delete flowTimestamps[userId]; return send(msg.chat.id, 'User not found.'); }
      awardSP(addU, addAmt);
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Added ${addAmt} SP to user #${flow.data.userId}.`);
      return true;
    case 'admin_removesp_amount':
      const remAmt = parseInt(text);
      if (isNaN(remAmt) || remAmt <= 0) return sendQ(msg.chat.id, 'Enter a valid positive number.');
      const remU = db.prepare('SELECT * FROM users WHERE id = ?').get(flow.data.userId);
      if (!remU) { delete adminFlows[userId]; delete flowTimestamps[userId]; return send(msg.chat.id, 'User not found.'); }
      updateUser(remU.id, { skillPoints: Math.max(0, remU.skillPoints - remAmt) });
      delete adminFlows[userId]; delete flowTimestamps[userId];
      send(msg.chat.id, `✅ Removed ${remAmt} SP from user #${flow.data.userId}.`);
      return true;
  }

  return false;
}

// ─── Nav aliases ───
handlers['/nav_help'] = handlers['/help'];
handlers['/nav_start'] = handlers['/start'];

// ═══════════════════════════════════════════
//  QUIZ FLOW
// ═══════════════════════════════════════════

function startQuiz(chatId, userId, quizId) {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
  if (!quiz) return send(chatId, 'Quiz not found.');
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE quizId = ? ORDER BY "order" ASC').all(quizId);
  if (questions.length === 0) return send(chatId, 'No questions in this quiz.');
  quizSessions[userId] = { quizId, questions, qIndex: 0, score: 0, answers: [], startTime: Date.now() };
  sessionTimestamps[userId] = Date.now();
  showQuestion(chatId, userId, quiz, questions, 0);
}

function showQuestion(chatId, userId, quiz, questions, qIndex) {
  const q = questions[qIndex];
  const opts = q.options.split(',');
  const progress = '●'.repeat(qIndex + 1) + '○'.repeat(questions.length - qIndex - 1);
  const buttons = opts.map((opt, i) => ([{ text: `${['A.','B.','C.','D.'][i]} ${opt.trim()}`, callback_data: `quiz_answer_${qIndex}_${i}` }]));

  send(chatId,
    `🧠 <b>${esc(quiz.title)}</b>\n\n` +
    `📊 Question ${qIndex + 1}/${questions.length}  ${progress}\n` +
    `💰 ${q.points} SP per correct answer\n\n` +
    `❓ ${esc(q.questionText)}`,
    { reply_markup: JSON.stringify({ inline_keyboard: buttons }) }
  );
}

function handleQuizAnswer(chatId, userId, qIndex, selectedIdx) {
  const session = quizSessions[userId];
  if (!session) return;
  if (session.waiting) return;
  const q = session.questions[qIndex];
  const isCorrect = selectedIdx === q.correctOptionIndex;
  if (isCorrect) session.score += 1;
  session.answers.push(selectedIdx);

  const opts = q.options.split(',');
  const resultText = isCorrect
    ? `✅ Correct!\n\n💡 ${q.explanation}`
    : `❌ Incorrect\n\n📝 Answer: ${opts[q.correctOptionIndex].trim()}\n💡 ${q.explanation}`;

  if (qIndex + 1 < session.questions.length) {
    session.waiting = true;
    session.qIndex = qIndex + 1;
    send(chatId, resultText + '\n\nNext question in 2s...');
    setTimeout(() => {
      if (!quizSessions[userId]) return;
      session.waiting = false;
      const quiz = session.isPoolQuiz
        ? { id: 0, title: '📅 Daily Quiz', totalPoints: session.questions.length * 10 }
        : db.prepare('SELECT * FROM quizzes WHERE id = ?').get(session.quizId);
      showQuestion(chatId, userId, quiz, session.questions, qIndex + 1);
    }, 2000);
  } else {
    finishQuiz(chatId, userId, session);
  }
}

function finishQuiz(chatId, userId, session) {
  const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
  const isPool = session.isPoolQuiz;
  const quiz = isPool ? null : db.prepare('SELECT * FROM quizzes WHERE id = ?').get(session.quizId);
  const correct = session.score;
  const total = session.questions.length;
  const pct = Math.round((correct / total) * 100);
  const spPerCorrect = 10;
  const earned = correct * spPerCorrect;
  const title = isPool ? '📅 Daily Quiz' : quiz.title;

  const result = awardSP(user, earned);
  updateUser(user.id, { quizzesCompleted: user.quizzesCompleted + 1 });
  if (!isPool) {
    db.prepare('INSERT INTO quiz_attempts (userId, quizId, score, totalPoints, correctAnswers, totalQuestions, completed, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, datetime(\'now\'))').run(user.id, quiz.id, correct, earned, correct, total);
  }

  const newBadges = checkBadges(user.id);
  const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  let grade = '';
  let msg = '';
  if (pct === 100) { grade = '🏆 PERFECT'; msg = 'Outstanding performance!'; }
  else if (pct >= 80) { grade = '🌟 EXCELLENT'; msg = 'Great work!'; }
  else if (pct >= 60) { grade = '👍 GOOD'; msg = 'Room to improve.'; }
  else if (pct >= 40) { grade = '📚 FAIR'; msg = 'Keep studying.'; }
  else { grade = '💪 KEEP TRYING'; msg = 'Practice makes perfect.'; }

  let text =
    `🎓 <b>Quiz Complete!</b>\n\n` +
    `${title}\n\n` +
    `🎯 Grade: ${grade}\n` +
    `📝 Score: ${correct}/${total} (${pct}%)\n` +
    `⭐ Points: +${earned} SP\n` +
    `${msg}\n\n` +
    `📈 <b>Updated Stats</b>\n` +
    `💰 Total SP: ${refreshed.skillPoints}\n` +
    `📊 Level: ${refreshed.level}\n`;

  if (result.leveled) text += `\n\n🎊 LEVEL UP! Now ${result.newLevel.name}!`;
  if (newBadges.length > 0) {
    text += `\n\n🏅 New Badges Earned:\n`;
    newBadges.forEach(b => { text += `   ${b.icon || '🏅'} ${b.name} (+${b.skillPointsReward} SP)\n`; });
  }

  delete quizSessions[userId];
  delete sessionTimestamps[userId];
  send(chatId, text, {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        isPool ? [{ text: '🔄 Retry Quiz', callback_data: 'start_daily_pool_quiz' }] : [{ text: '🔄 Retry Quiz', callback_data: `start_quiz_${quiz.id}` }],
        [{ text: '📊 Leaderboard', callback_data: 'nav_leaderboard' }],
        [{ text: '🏠 Home', callback_data: 'nav_start' }],
      ]
    })
  });
}

// ═══════════════════════════════════════════
//  CALLBACK ROUTER
// ═══════════════════════════════════════════

function handleCallback(cb) {
  const data = cb.data;
  const userId = cb.from.id;
  const chatId = cb.message.chat.id;

  if (data === 'nav_start') { answerCB(cb.id); return handlers['/nav_start']({ chat: { id: chatId }, from: { id: userId, first_name: cb.from.first_name, username: cb.from.username }, text: '/start' }); }
  if (data.startsWith('cat_')) {
    answerCB(cb.id);
    const catMap = {
      'Cybersecurity': 'Cybersecurity', 'Automation': 'Automation',
      'MobileApp': 'Mobile App', 'Website': 'Website', 'UXUIDesign': 'UX/UI Design',
      'VideoEditing': 'Video Editing', 'GraphicsDesign': 'Graphics Design',
      'AIDataScience': 'AI & Data Science', 'Coding': 'Coding',
      'BasicComputerSkills': 'Basic Computer Skills',
      'DataScience': 'Data Science', 'DataAnalytics': 'Data Analytics', 'R': 'R',
      'Frontend': 'Frontend', 'Backend': 'Backend', 'Python': 'Python', 'DSA': 'DSA',
      'Accounting': 'Accounting', 'DigitalMarketing': 'Digital Marketing',
      'SocialMediaManagement': 'Social Media Management',
      'OdooFunctional': 'Odoo Functional', 'OdooTechnical': 'Odoo Technical',
      'ERPNextFunctional': 'ERPNext Functional', 'ERPNextTechnical': 'ERPNext Technical',
    };
    const catKey = data.replace('cat_', '');
    const category = catMap[catKey];
    if (category) return sendChallengesByCategory(chatId, category);
    return sendChallenges(chatId);
  }
  // ── Admin Callbacks (intercepted before nav_ routing) ──
  if (data === 'admin_cancel') { answerCB(cb.id); if (!isAdmin(userId)) return; delete adminFlows[userId]; delete flowTimestamps[userId]; return sendAdminPanel(chatId, userId); }
  if (data === 'nav_admin' || data === 'admin_panel') { answerCB(cb.id); if (!isAdmin(userId)) return; return sendAdminPanel(chatId, userId); }

  if (data.startsWith('nav_')) { answerCB(cb.id); const cmd = '/' + data; if (handlers[cmd]) return handlers[cmd]({ chat: { id: chatId }, from: { id: userId, first_name: cb.from.first_name, username: cb.from.username } }); }
  if (data === 'admin_quizzes') { answerCB(cb.id); if (isAdmin(userId)) return sendQuizListAdmin(chatId); }
  if (data === 'admin_challenges') { answerCB(cb.id); if (isAdmin(userId)) return sendChallengeListAdmin(chatId); }
  if (data === 'admin_rewards') { answerCB(cb.id); if (isAdmin(userId)) return sendRewardListAdmin(chatId); }
  if (data === 'admin_badges') { answerCB(cb.id); if (isAdmin(userId)) return sendBadgeListAdmin(chatId); }
  if (data === 'admin_quizpool') {
    answerCB(cb.id);
    if (!isAdmin(userId)) return;
    const stats = getPoolStats();
    let text = `📋 <b>Quiz Pool</b>\n\n`;
    text += `📝 Total: ${stats.total} questions\n`;
    text += `✅ Used: ${stats.totalUsed}\n`;
    text += `⏳ Remaining: ${stats.remaining}\n`;
    text += `📅 Days covered: ~${stats.daysCovered}\n\n`;
    text += `<b>By Category:</b>\n`;
    if (stats.byCategory.length > 0) {
      stats.byCategory.forEach(c => { text += `  ${c.category}: ${c.c}\n`; });
    } else {
      text += `  No questions yet\n`;
    }
    return send(chatId, text, {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '🔄 Reload from File', callback_data: 'admin_reloadpool' }],
          [{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }],
        ]
      })
    });
  }
  if (data === 'admin_reloadpool') {
    answerCB(cb.id);
    if (!isAdmin(userId)) return;
    try {
      const result = syncPoolFromFile();
      const stats = getPoolStats();
      send(chatId,
        `✅ <b>Pool Reloaded</b>\n\n➕ Added: ${result.added}\n🔄 Updated: ${result.updated}\n\nTotal: ${stats.total} questions`,
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '📋 Quiz Pool', callback_data: 'admin_quizpool' }], [{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]] }) }
      );
    } catch (err) {
      send(chatId, `❌ Error: ${err.message}`);
    }
  }

  if (data === 'admin_users') {
    answerCB(cb.id);
    if (!isAdmin(userId)) return;
    const users = db.prepare('SELECT * FROM users ORDER BY skillPoints DESC LIMIT 20').all();
    let text = `👥 <b>Users</b> (${users.length} shown)\n\n`;
    const medals = ['🥇', '🥈', '🥉'];
    const buttons = [];
    users.forEach((u, i) => {
      const lvl = getLevel(u.xp);
      const rank = i < 3 ? medals[i] : `#${i + 1}`;
      const status = u.isActive ? '🟢' : '🔴';
      text += `${rank} ${status} ${esc(u.firstName)} (@${esc(u.username || '—')})\n   ${lvl.name} · ${u.skillPoints} SP · ${u.streak}d\n\n`;
      buttons.push([{ text: `${status} ${esc(u.firstName)} — ${u.skillPoints} SP`, callback_data: `admin_user_${u.id}` }]);
    });
    buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'nav_admin' }]);
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }

  if (data === 'admin_broadcast') {
    answerCB(cb.id);
    if (!isAdmin(userId)) return;
    adminFlows[userId] = { step: 'admin_broadcast_text', data: {} };
    return send(chatId, `📢 <b>Broadcast</b>\n\nSend /cancel to abort.\n\nSend your message:`, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) });
  }

  if (data === 'admin_submissions') {
    answerCB(cb.id);
    if (!isAdmin(userId)) return;
    const subs = db.prepare('SELECT cs.*, u.firstName, u.username, c.title as challengeTitle FROM challenge_submissions cs JOIN users u ON cs.userId = u.id JOIN challenges c ON cs.challengeId = c.id WHERE cs.completed = 0 ORDER BY cs.createdAt DESC LIMIT 10').all();
    if (subs.length === 0) return send(chatId, `⏳ <b>Pending Reviews</b>\n\nNo pending submissions.`, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) });
    let text = `⏳ <b>Pending Reviews</b>\n\n`;
    const buttons = [];
    subs.forEach(s => {
      text += `${esc(s.challengeTitle)}\n` +
        `${esc(s.firstName)}\n` +
        `${s.githubUrl || s.solution}\n\n`;
      buttons.push([{ text: `Approve #${s.id}`, callback_data: `admin_approve_${s.id}` }, { text: `Reject #${s.id}`, callback_data: `admin_reject_${s.id}` }]);
    });
    buttons.push([{ text: 'Admin Panel', callback_data: 'nav_admin' }]);
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }

  if (data.startsWith('admin_approve_')) {
    if (!isAdmin(userId)) return answerCB(cb.id);
    answerCB(cb.id, 'Approved');
    const subId = parseInt(data.replace('admin_approve_', ''));
    const sub = db.prepare('SELECT * FROM challenge_submissions WHERE id = ?').get(subId);
    if (!sub) return send(chatId, 'Submission not found.');

    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(sub.challengeId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.userId);
    if (!user || !challenge) return send(chatId, 'User or challenge not found.');

    const result = awardSP(user, challenge.points);
    updateUser(user.id, { challengesCompleted: (user.challengesCompleted || 0) + 1 });
    if (challenge.category === 'Python') updateUser(user.id, { pythonChallenges: (user.pythonChallenges || 0) + 1 });
    if (challenge.category === 'AI') updateUser(user.id, { aiChallenges: (user.aiChallenges || 0) + 1 });

    db.prepare('UPDATE challenge_submissions SET completed = 1, pointsAwarded = ?, reviewedBy = ? WHERE id = ?').run(challenge.points, String(userId), subId);

    const newBadges = checkBadges(user.id);
    const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

      let userMsg =
        `✅ <b>Submission Approved!</b>\n\n` +
        `${challenge.title}\n` +
        `+${challenge.points} SP earned\n`;

      if (result.leveled) userMsg += `\n🎊 LEVEL UP! Now ${result.newLevel.name}!`;
    if (newBadges.length > 0) {
      userMsg += `\n\n🏅 New Badges Earned:\n`;
      newBadges.forEach(b => { userMsg += `   ${b.icon || '-'} ${b.name} (+${b.skillPointsReward} SP)\n`; });
    }

    send(user.telegramId, userMsg, {
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Home', callback_data: 'nav_start' }]] })
    });
    return send(chatId, `✅ Submission #${subId} approved. ${user.firstName} awarded ${challenge.points} SP.`);
  }

  if (data.startsWith('admin_reject_')) {
    if (!isAdmin(userId)) return answerCB(cb.id);
    answerCB(cb.id, 'Rejected');
    const subId = parseInt(data.replace('admin_reject_', ''));
    const sub = db.prepare('SELECT * FROM challenge_submissions WHERE id = ?').get(subId);
    if (sub) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.userId);
      if (user) send(user.telegramId, `Your submission was not approved.\n\nPlease review the requirements and try again.`, {
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Challenges', callback_data: 'nav_challenges' }], [{ text: 'Home', callback_data: 'nav_start' }]] })
      });
    }
    db.prepare('DELETE FROM challenge_submissions WHERE id = ?').run(subId);
    return send(chatId, `Submission #${subId} rejected.`);
  }

  if (data.startsWith('admin_delquiz_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_delquiz_', ''));
    db.prepare('DELETE FROM quiz_questions WHERE quizId = ?').run(id);
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(id);
    send(chatId, `Quiz #${id} deleted.`);
    return sendQuizListAdmin(chatId);
  }

  if (data.startsWith('admin_delchallenge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_delchallenge_', ''));
    db.prepare('DELETE FROM challenge_submissions WHERE challengeId = ?').run(id);
    db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
    send(chatId, `Challenge #${id} deleted.`);
    return sendChallengeListAdmin(chatId);
  }

  if (data.startsWith('admin_delreward_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_delreward_', ''));
    db.prepare('DELETE FROM rewards WHERE id = ?').run(id);
    send(chatId, `Reward #${id} deleted.`);
    return sendRewardListAdmin(chatId);
  }

  if (data.startsWith('admin_delevent_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_delevent_', ''));
    db.prepare('DELETE FROM event_registrations WHERE eventId = ?').run(id);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    send(chatId, `Event #${id} deleted.`);
    return sendEventListAdmin(chatId);
  }

  if (data.startsWith('admin_delbadge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_delbadge_', ''));
    db.prepare('DELETE FROM user_badges WHERE badgeId = ?').run(id);
    db.prepare('DELETE FROM badges WHERE id = ?').run(id);
    send(chatId, `Badge #${id} deleted.`);
    return sendBadgeListAdmin(chatId);
  }

  if (data === 'admin_addquiz') { answerCB(cb.id); if (isAdmin(userId)) return handlers['/addquiz']({ chat: { id: chatId }, from: { id: userId }, text: '/addquiz' }); }
  if (data === 'admin_addchallenge') { answerCB(cb.id); if (isAdmin(userId)) return handlers['/addchallenge']({ chat: { id: chatId }, from: { id: userId }, text: '/addchallenge' }); }
  if (data === 'admin_addreward') { answerCB(cb.id); if (isAdmin(userId)) return handlers['/addreward']({ chat: { id: chatId }, from: { id: userId }, text: '/addreward' }); }
  if (data === 'admin_addevent') { answerCB(cb.id); if (isAdmin(userId)) return handlers['/addevent']({ chat: { id: chatId }, from: { id: userId }, text: '/addevent' }); }
  if (data === 'admin_addbadge') { answerCB(cb.id); if (isAdmin(userId)) return handlers['/addbadge']({ chat: { id: chatId }, from: { id: userId }, text: '/addbadge' }); }

  if (data.startsWith('admin_addq_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const quizId = parseInt(data.replace('admin_addq_', ''));
    return handlers['/addquestion']({ chat: { id: chatId }, from: { id: userId }, text: `/addquestion ${quizId}` });
  }

  // ── Quiz Toggle / Daily / Questions / Edit ──
  if (data.startsWith('admin_togglequiz_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_togglequiz_', ''));
    const q = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
    if (!q) return send(chatId, 'Quiz not found.');
    db.prepare('UPDATE quizzes SET isActive = ? WHERE id = ?').run(q.isActive ? 0 : 1, id);
    send(chatId, `Quiz #${id} ${q.isActive ? 'deactivated' : 'activated'}.`);
    return sendQuizListAdmin(chatId);
  }
  if (data.startsWith('admin_setdailyquiz_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_setdailyquiz_', ''));
    db.prepare('UPDATE quizzes SET isDaily = 1 WHERE id = ?').run(id);
    send(chatId, `Quiz #${id} set as daily.`);
    return sendQuizListAdmin(chatId);
  }
  if (data.startsWith('admin_unsetdailyquiz_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_unsetdailyquiz_', ''));
    db.prepare('UPDATE quizzes SET isDaily = 0 WHERE id = ?').run(id);
    send(chatId, `Quiz #${id} removed from daily.`);
    return sendQuizListAdmin(chatId);
  }
  if (data.startsWith('admin_listquestions_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const quizId = parseInt(data.replace('admin_listquestions_', ''));
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
    if (!quiz) return send(chatId, 'Quiz not found.');
    const questions = db.prepare('SELECT * FROM quiz_questions WHERE quizId = ? ORDER BY "order" ASC').all(quizId);
    let text = `❓ <b>Questions: ${esc(quiz.title)}</b>\n\n`;
    const buttons = [];
    questions.forEach(q => {
      const opts = q.options.split(',');
      text += `#${q.id} (${q.points} SP)\n${esc(q.questionText)}\n   A: ${esc(opts[0])} | B: ${esc(opts[1])}\n   C: ${esc(opts[2])} | D: ${esc(opts[3])}\n\n`;
      buttons.push([{ text: `🗑 Del #${q.id}`, callback_data: `admin_delquestion_${q.id}_${quizId}` }]);
    });
    if (questions.length === 0) text += `No questions yet.\n`;
    buttons.push([{ text: '➕ Add Question', callback_data: `admin_addq_${quizId}` }]);
    buttons.push([{ text: '← Back to Quizzes', callback_data: 'admin_quizzes' }]);
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }
  if (data.startsWith('admin_delquestion_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const rest = data.replace('admin_delquestion_', '');
    const sep = rest.lastIndexOf('_');
    const qId = parseInt(rest.substring(0, sep));
    const quizId = parseInt(rest.substring(sep + 1));
    db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(qId);
    send(chatId, `Question #${qId} deleted.`);
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
    if (!quiz) return;
    const questions = db.prepare('SELECT * FROM quiz_questions WHERE quizId = ? ORDER BY "order" ASC').all(quizId);
    let text = `❓ <b>Questions: ${esc(quiz.title)}</b>\n\n`;
    const buttons = [];
    questions.forEach(q => {
      const opts = q.options.split(',');
      text += `#${q.id} (${q.points} SP)\n${esc(q.questionText)}\n   A: ${esc(opts[0])} | B: ${esc(opts[1])}\n   C: ${esc(opts[2])} | D: ${esc(opts[3])}\n\n`;
      buttons.push([{ text: `🗑 Del #${q.id}`, callback_data: `admin_delquestion_${q.id}_${quizId}` }]);
    });
    if (questions.length === 0) text += `No questions yet.\n`;
    buttons.push([{ text: '➕ Add Question', callback_data: `admin_addq_${quizId}` }]);
    buttons.push([{ text: '← Back to Quizzes', callback_data: 'admin_quizzes' }]);
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }
  if (data.startsWith('admin_editquiz_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_editquiz_', ''));
    const q = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
    if (!q) return send(chatId, 'Quiz not found.');
    return send(chatId,
      `✏️ <b>Edit Quiz #${id}</b>\n\n` +
      `Title: ${esc(q.title)}\n` +
      `Category: ${esc(q.category)}\n` +
      `Points: ${q.totalPoints}\n` +
      `Description: ${esc(q.description || '—')}\n\n` +
      `Select field to edit:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [
        [{ text: 'Title', callback_data: `admin_eqfield_${id}_title` }, { text: 'Description', callback_data: `admin_eqfield_${id}_description` }],
        [{ text: 'Category', callback_data: `admin_eqfield_${id}_category` }, { text: 'Points', callback_data: `admin_eqfield_${id}_totalPoints` }],
        [{ text: '← Back', callback_data: 'admin_quizzes' }]
      ] }) }
    );
  }
  if (data.startsWith('admin_eqfield_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const rest = data.replace('admin_eqfield_', '');
    const sep = rest.lastIndexOf('_');
    const id = parseInt(rest.substring(0, sep));
    const field = rest.substring(sep + 1);
    adminFlows[userId] = { step: `editquiz_${field}`, data: { quizId: id } };
    flowTimestamps[userId] = Date.now();
    const q = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
    return send(chatId,
      `✏️ <b>Edit Quiz #${id} → ${field}</b>\n\nCurrent: ${esc(String(q[field]))}\n\nSend new value or /cancel:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
    );
  }

  // ── Challenge Toggle / Daily / Edit ──
  if (data.startsWith('admin_togglechallenge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_togglechallenge_', ''));
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    if (!c) return send(chatId, 'Challenge not found.');
    db.prepare('UPDATE challenges SET isActive = ? WHERE id = ?').run(c.isActive ? 0 : 1, id);
    send(chatId, `Challenge #${id} ${c.isActive ? 'deactivated' : 'activated'}.`);
    return sendChallengeListAdmin(chatId);
  }
  if (data.startsWith('admin_setdailychallenge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_setdailychallenge_', ''));
    db.prepare('UPDATE challenges SET isDaily = 1 WHERE id = ?').run(id);
    send(chatId, `Challenge #${id} set as daily.`);
    return sendChallengeListAdmin(chatId);
  }
  if (data.startsWith('admin_unsetdailychallenge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_unsetdailychallenge_', ''));
    db.prepare('UPDATE challenges SET isDaily = 0 WHERE id = ?').run(id);
    send(chatId, `Challenge #${id} removed from daily.`);
    return sendChallengeListAdmin(chatId);
  }
  if (data.startsWith('admin_editchallenge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_editchallenge_', ''));
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    if (!c) return send(chatId, 'Challenge not found.');
    return send(chatId,
      `✏️ <b>Edit Challenge #${id}</b>\n\n` +
      `Title: ${esc(c.title)}\n` +
      `Category: ${esc(c.category)}\n` +
      `Points: ${c.points}\n` +
      `Difficulty: ${c.difficulty}/5\n\n` +
      `Select field to edit:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [
        [{ text: 'Title', callback_data: `admin_ecfield_${id}_title` }, { text: 'Description', callback_data: `admin_ecfield_${id}_description` }],
        [{ text: 'Category', callback_data: `admin_ecfield_${id}_category` }, { text: 'Points', callback_data: `admin_ecfield_${id}_points` }],
        [{ text: 'Difficulty', callback_data: `admin_ecfield_${id}_difficulty` }],
        [{ text: '← Back', callback_data: 'admin_challenges' }]
      ] }) }
    );
  }
  if (data.startsWith('admin_ecfield_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const rest = data.replace('admin_ecfield_', '');
    const sep = rest.lastIndexOf('_');
    const id = parseInt(rest.substring(0, sep));
    const field = rest.substring(sep + 1);
    adminFlows[userId] = { step: `editchallenge_${field}`, data: { challengeId: id } };
    flowTimestamps[userId] = Date.now();
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    return send(chatId,
      `✏️ <b>Edit Challenge #${id} → ${field}</b>\n\nCurrent: ${esc(String(c[field]))}\n\nSend new value or /cancel:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
    );
  }

  // ── Reward Toggle / Edit ──
  if (data.startsWith('admin_togglereward_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_togglereward_', ''));
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
    if (!r) return send(chatId, 'Reward not found.');
    db.prepare('UPDATE rewards SET isActive = ? WHERE id = ?').run(r.isActive ? 0 : 1, id);
    send(chatId, `Reward #${id} ${r.isActive ? 'deactivated' : 'activated'}.`);
    return sendRewardListAdmin(chatId);
  }
  if (data.startsWith('admin_editreward_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_editreward_', ''));
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
    if (!r) return send(chatId, 'Reward not found.');
    return send(chatId,
      `✏️ <b>Edit Reward #${id}</b>\n\n` +
      `Name: ${esc(r.name)}\n` +
      `Cost: ${r.skillPointsCost} SP\n` +
      `Stock: ${r.stock === -1 ? '∞' : r.stock}\n` +
      `Category: ${esc(r.category)}\n\n` +
      `Select field to edit:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [
        [{ text: 'Name', callback_data: `admin_erfield_${id}_name` }, { text: 'Description', callback_data: `admin_erfield_${id}_description` }],
        [{ text: 'Cost', callback_data: `admin_erfield_${id}_skillPointsCost` }, { text: 'Stock', callback_data: `admin_erfield_${id}_stock` }],
        [{ text: 'Category', callback_data: `admin_erfield_${id}_category` }],
        [{ text: '← Back', callback_data: 'admin_rewards' }]
      ] }) }
    );
  }
  if (data.startsWith('admin_erfield_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const rest = data.replace('admin_erfield_', '');
    const sep = rest.lastIndexOf('_');
    const id = parseInt(rest.substring(0, sep));
    const field = rest.substring(sep + 1);
    adminFlows[userId] = { step: `editreward_${field}`, data: { rewardId: id } };
    flowTimestamps[userId] = Date.now();
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
    return send(chatId,
      `✏️ <b>Edit Reward #${id} → ${field}</b>\n\nCurrent: ${esc(String(r[field]))}\n\nSend new value or /cancel:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
    );
  }

  // ── Badge Toggle / Edit ──
  if (data.startsWith('admin_togglebadge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_togglebadge_', ''));
    const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(id);
    if (!b) return send(chatId, 'Badge not found.');
    db.prepare('UPDATE badges SET isActive = ? WHERE id = ?').run(b.isActive ? 0 : 1, id);
    send(chatId, `Badge #${id} ${b.isActive ? 'deactivated' : 'activated'}.`);
    return sendBadgeListAdmin(chatId);
  }
  if (data.startsWith('admin_editbadge_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_editbadge_', ''));
    const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(id);
    if (!b) return send(chatId, 'Badge not found.');
    return send(chatId,
      `✏️ <b>Edit Badge #${id}</b>\n\n` +
      `${b.icon} ${esc(b.name)}\n` +
      `Requirement: ${esc(b.requirement)}\n` +
      `SP Reward: ${b.skillPointsReward}\n\n` +
      `Select field to edit:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [
        [{ text: 'Name', callback_data: `admin_ebfield_${id}_name` }, { text: 'Icon', callback_data: `admin_ebfield_${id}_icon` }],
        [{ text: 'Description', callback_data: `admin_ebfield_${id}_description` }, { text: 'Requirement', callback_data: `admin_ebfield_${id}_requirement` }],
        [{ text: 'SP Reward', callback_data: `admin_ebfield_${id}_skillPointsReward` }],
        [{ text: '← Back', callback_data: 'admin_badges' }]
      ] }) }
    );
  }
  if (data.startsWith('admin_ebfield_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const rest = data.replace('admin_ebfield_', '');
    const sep = rest.lastIndexOf('_');
    const id = parseInt(rest.substring(0, sep));
    const field = rest.substring(sep + 1);
    adminFlows[userId] = { step: `editbadge_${field}`, data: { badgeId: id } };
    flowTimestamps[userId] = Date.now();
    const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(id);
    return send(chatId,
      `✏️ <b>Edit Badge #${id} → ${field}</b>\n\nCurrent: ${esc(String(b[field]))}\n\nSend new value or /cancel:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) }
    );
  }

  // ── Event Toggle ──
  if (data.startsWith('admin_toggleevent_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_toggleevent_', ''));
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) return send(chatId, 'Event not found.');
    db.prepare('UPDATE events SET isActive = ? WHERE id = ?').run(e.isActive ? 0 : 1, id);
    send(chatId, `Event #${id} ${e.isActive ? 'deactivated' : 'activated'}.`);
    return sendEventListAdmin(chatId);
  }

  // ── Redemptions ──
  if (data === 'admin_redemptions') {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    let redemptions = [];
    try {
      redemptions = db.prepare("SELECT rr.*, u.firstName, u.username, r.name as rewardName FROM reward_redemptions rr JOIN users u ON rr.userId = u.id JOIN rewards r ON rr.rewardId = r.id ORDER BY rr.redeemedAt DESC LIMIT 10").all();
    } catch (_) {}
    if (redemptions.length === 0) return send(chatId, `🔄 <b>Redemptions</b>\n\nNo redemptions yet.`, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Admin Panel', callback_data: 'nav_admin' }]] }) });
    let text = `🔄 <b>Redemptions</b>\n\n`;
    const buttons = [];
    redemptions.forEach(r => {
      const statusIcon = r.status === 'pending' ? '⏳' : r.status === 'approved' ? '✅' : '❌';
      text += `${statusIcon} #${r.id} ${esc(r.rewardName)}\n   👤 ${esc(r.firstName)} · ${r.pointsSpent} SP · ${r.status}\n\n`;
      if (r.status === 'pending') {
        buttons.push([{ text: `✅ Approve #${r.id}`, callback_data: `admin_approveredemption_${r.id}` }, { text: `❌ Reject #${r.id}`, callback_data: `admin_rejectredemption_${r.id}` }]);
      }
    });
    buttons.push([{ text: 'Admin Panel', callback_data: 'nav_admin' }]);
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }
  if (data.startsWith('admin_approveredemption_')) {
    answerCB(cb.id, 'Approved'); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_approveredemption_', ''));
    try {
      db.prepare("UPDATE reward_redemptions SET status = 'approved' WHERE id = ? AND status = 'pending'").run(id);
      const red = db.prepare('SELECT rr.*, u.telegramId FROM reward_redemptions rr JOIN users u ON rr.userId = u.id WHERE rr.id = ?').get(id);
      if (red) send(parseInt(red.telegramId), `✅ Your redemption #${id} has been approved! Our team will contact you shortly.`);
    } catch (_) {}
    send(chatId, `Redemption #${id} approved.`);
    return handlers['admin_redemptions'] ? null : sendAdminPanel(chatId, userId);
  }
  if (data.startsWith('admin_rejectredemption_')) {
    answerCB(cb.id, 'Rejected'); if (!isAdmin(userId)) return;
    const id = parseInt(data.replace('admin_rejectredemption_', ''));
    try {
      const red = db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(id);
      if (red) {
        db.prepare("UPDATE reward_redemptions SET status = 'rejected' WHERE id = ?").run(id);
        db.prepare('UPDATE rewards SET stock = stock + 1 WHERE id = ?').run(red.rewardId);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(red.userId);
        if (user) {
          updateUser(user.id, { skillPoints: user.skillPoints + red.pointsSpent });
          send(parseInt(user.telegramId), `❌ Your redemption #${id} was not approved.\n${red.pointsSpent} SP has been refunded.`);
        }
      }
    } catch (_) {}
    send(chatId, `Redemption #${id} rejected.`);
    return sendAdminPanel(chatId, userId);
  }

  // ── User Management ──
  if (data.startsWith('admin_user_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_user_', ''));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) return send(chatId, 'User not found.');
    const lvl = getLevel(user.xp);
    const text =
      `👤 <b>User Profile</b>\n\n` +
      `Name: ${esc(user.firstName)} ${esc(user.lastName || '')}\n` +
      `Username: @${esc(user.username || '—')}\n` +
      `Telegram ID: ${user.telegramId}\n` +
      `Country: ${esc(user.country || '—')} · City: ${esc(user.city || '—')}\n\n` +
      `📊 Level: ${lvl.name} (${user.xp} XP)\n` +
      `💰 SP: ${user.skillPoints}\n` +
      `🔥 Streak: ${user.streak} days\n` +
      `📝 Quizzes: ${user.quizzesCompleted}\n` +
      `🏆 Challenges: ${user.challengesCompleted}\n` +
      `👥 Referrals: ${user.referralsCount}\n\n` +
      `Admin: ${user.isAdmin ? 'Yes' : 'No'}\n` +
      `Active: ${user.isActive ? 'Yes' : 'No'}\n` +
      `Joined: ${user.createdAt}`;
    const buttons = [
      [{ text: `➕ Add SP`, callback_data: `admin_addsp_${user.id}` }, { text: `➖ Remove SP`, callback_data: `admin_removesp_${user.id}` }],
      [{ text: `${user.isActive ? '🚫 Ban' : '✅ Unban'} User`, callback_data: `${user.isActive ? 'admin_ban' : 'admin_unban'}_${user.id}` }],
      [{ text: `${user.isAdmin ? '❌ Remove Admin' : '👑 Make Admin'}`, callback_data: `${user.isAdmin ? 'admin_demote' : 'admin_promote'}_${user.id}` }],
      [{ text: '← Back to Users', callback_data: 'admin_users' }]
    ];
    return send(chatId, text, { reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }
  if (data.startsWith('admin_addsp_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_addsp_', ''));
    adminFlows[userId] = { step: 'admin_addsp_amount', data: { userId: uid } };
    flowTimestamps[userId] = Date.now();
    return send(chatId, `💰 <b>Add SP</b>\n\nSend amount of SP to add or /cancel:`, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) });
  }
  if (data.startsWith('admin_removesp_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_removesp_', ''));
    adminFlows[userId] = { step: 'admin_removesp_amount', data: { userId: uid } };
    flowTimestamps[userId] = Date.now();
    return send(chatId, `💰 <b>Remove SP</b>\n\nSend amount of SP to remove or /cancel:`, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Cancel', callback_data: 'admin_cancel' }]] }) });
  }
  if (data.startsWith('admin_ban_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_ban_', ''));
    db.prepare('UPDATE users SET isActive = 0 WHERE id = ?').run(uid);
    send(chatId, `User #${uid} banned.`);
    return sendAdminPanel(chatId, userId);
  }
  if (data.startsWith('admin_unban_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_unban_', ''));
    db.prepare('UPDATE users SET isActive = 1 WHERE id = ?').run(uid);
    send(chatId, `User #${uid} unbanned.`);
    return sendAdminPanel(chatId, userId);
  }
  if (data.startsWith('admin_promote_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_promote_', ''));
    db.prepare('UPDATE users SET isAdmin = 1 WHERE id = ?').run(uid);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (user) send(parseInt(user.telegramId), `🎉 You have been promoted to admin!`);
    send(chatId, `User #${uid} promoted to admin.`);
    return sendAdminPanel(chatId, userId);
  }
  if (data.startsWith('admin_demote_')) {
    answerCB(cb.id); if (!isAdmin(userId)) return;
    const uid = parseInt(data.replace('admin_demote_', ''));
    db.prepare('UPDATE users SET isAdmin = 0 WHERE id = ?').run(uid);
    send(chatId, `User #${uid} demoted.`);
    return sendAdminPanel(chatId, userId);
  }

  // ── User Callbacks ──
  if (data === 'start_daily_pool_quiz') { answerCB(cb.id, 'Starting...'); return startPoolQuiz(chatId, userId); }
  if (data.startsWith('start_quiz_')) { answerCB(cb.id, 'Starting...'); return startQuiz(chatId, userId, parseInt(data.replace('start_quiz_', ''))); }

  if (data.startsWith('quiz_answer_')) {
    const parts = data.split('_');
    answerCB(cb.id);
    return handleQuizAnswer(chatId, userId, parseInt(parts[2]), parseInt(parts[3]));
  }

  if (data.startsWith('view_challenge_')) {
    answerCB(cb.id);
    const cId = parseInt(data.replace('view_challenge_', ''));
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(cId);
    if (!c) return;
    const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
    const sub = user ? db.prepare('SELECT * FROM challenge_submissions WHERE userId = ? AND challengeId = ?').get(user.id, cId) : null;

    let text =
      `⚔️ <b>${esc(c.title)}</b>\n\n` +
      `<b>Description:</b>\n${esc(c.description || 'No description provided.')}\n\n` +
      `📂 Category: ${esc(c.category)}\n` +
      `💰 Points: ${c.points} SP\n` +
      `📊 Difficulty: ${'★'.repeat(c.difficulty)}${'☆'.repeat(5 - c.difficulty)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 <b>How to Submit</b>\n` +
      `1. Complete the challenge task\n` +
      `2. Upload your solution to GitHub\n` +
      `3. Click the <b>Submit Solution</b> button below\n` +
      `4. Paste your GitHub repo link\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📝 <b>How it's Graded</b>\n` +
      `• Your submission is reviewed by an admin\n` +
      `• Points are awarded based on completeness &amp; quality\n` +
      `• You'll be notified once approved\n` +
      `• Awarded SP is added to your balance instantly\n`;

    if (sub && sub.completed) {
      text += `\n✅ <b>Status: Completed</b>\n💰 Points earned: ${sub.pointsAwarded} SP`;
      if (sub.reviewFeedback) text += `\n💬 Feedback: ${esc(sub.reviewFeedback)}`;
    } else if (sub && !sub.completed) {
      text += `\n⏳ <b>Status: Pending Review</b>\nSubmitted: ${sub.createdAt}`;
    } else {
      text += `\n📝 <b>Status: Not Started</b>`;
    }

    return send(chatId, text, {
      reply_markup: JSON.stringify({
        inline_keyboard: sub && sub.completed
          ? [[{ text: '🏆 More Challenges', callback_data: 'nav_challenges' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]]
          : sub && !sub.completed
            ? [[{ text: '⏳ Awaiting Review', callback_data: 'nav_challenges' }], { text: '🏆 More Challenges', callback_data: 'nav_challenges' }, [{ text: '🏠 Home', callback_data: 'nav_start' }]]
            : [[{ text: '📤 Submit Solution', callback_data: `submit_challenge_${c.id}` }], [{ text: '🏆 More Challenges', callback_data: 'nav_challenges' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]]
      })
    });
  }

  if (data.startsWith('submit_challenge_')) {
    answerCB(cb.id);
    const cId = parseInt(data.replace('submit_challenge_', ''));
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(cId);
    if (!c) return send(chatId, 'Challenge not found.');
    const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
    if (!user) return send(chatId, 'Send /start first.');
    const existing = db.prepare('SELECT * FROM challenge_submissions WHERE userId = ? AND challengeId = ?').get(user.id, cId);
    if (existing && existing.completed) return send(chatId, 'You already completed this challenge.');
    if (existing && !existing.completed) return send(chatId, '⏳ Your submission is already pending review. Please wait for admin approval.');
    userFlows[userId] = { step: 'submit_url', data: { challengeId: cId } };
    flowTimestamps[userId] = Date.now();
    return send(chatId,
      `📤 <b>Submit Solution</b>\n\n` +
      `Challenge: <b>${esc(c.title)}</b>\n` +
      `Points: ${c.points} SP\n\n` +
      `Send your GitHub repository URL or live demo link:`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'nav_challenges' }]] }) }
    );
  }

  if (data.startsWith('redeem_')) {
    answerCB(cb.id);
    const rId = parseInt(data.replace('redeem_', ''));
    const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(rId);
    const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
    if (!reward) return send(chatId, 'Reward not found.');
    if (!user) return send(chatId, 'Send /start first.');
    if (user.skillPoints < reward.skillPointsCost) return send(chatId, `Insufficient SP. You have ${user.skillPoints} SP but need ${reward.skillPointsCost} SP.`);

    if (reward.stock > 0) db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(rId);
    updateUser(user.id, { skillPoints: user.skillPoints - reward.skillPointsCost });
    db.prepare('INSERT INTO reward_redemptions (userId, rewardId, pointsSpent, status) VALUES (?, ?, ?, \'pending\')').run(user.id, rId, reward.skillPointsCost);
    const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    return send(chatId,
      `🎁 <b>Redemption Complete!</b>\n\n` +
      `🎁 ${reward.name}\n` +
      `💸 Spent: ${reward.skillPointsCost} SP\n` +
      `💰 Remaining: ${refreshed.skillPoints} SP\n\n` +
      `Our team will contact you shortly.`,
      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🎁 More Rewards', callback_data: 'nav_rewards' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
    );
  }

  if (data.startsWith('view_event_')) {
    answerCB(cb.id);
    const eId = parseInt(data.replace('view_event_', ''));
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eId);
    if (!event) return send(chatId, 'Event not found.');

    const user = db.prepare('SELECT * FROM users WHERE telegramId = ?').get(String(userId));
    const reg = user ? db.prepare('SELECT * FROM event_registrations WHERE userId = ? AND eventId = ?').get(user.id, eId) : null;

    const date = new Date(event.startsAt);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const spotsLeft = event.maxAttendees > 0 ? `${event.currentAttendees}/${event.maxAttendees}` : 'Unlimited';
    const typeIcon = event.type === 'workshop' ? '🔧' : event.type === 'hackathon' ? '💻' : event.type === 'meetup' ? '🤝' : '📅';

    let text =
      `${typeIcon} <b>${esc(event.title)}</b>\n\n` +
      `${esc(event.description || 'No description')}\n\n` +
      `📅 ${dateStr}\n` +
      `💰 +${event.skillPointsReward} SP\n` +
      `👥 ${spotsLeft} spots\n\n`;

    if (reg) {
      text += `✅ You are registered!`;
    } else {
      text += `Tap below to register.`;
    }

    return send(chatId, text, {
      reply_markup: JSON.stringify({
        inline_keyboard: reg
          ? [[{ text: '📅 More Events', callback_data: 'nav_events' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]]
          : [[{ text: '✅ Register', callback_data: `register_event_${eId}` }], [{ text: '📅 More Events', callback_data: 'nav_events' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]]
      })
    });
  }

  if (data.startsWith('register_event_')) {
    answerCB(cb.id, 'Registering...');
    const eId = parseInt(data.replace('register_event_', ''));
    return handleEventRegistration(chatId, userId, eId);
  }

  answerCB(cb.id);
}

// ═══════════════════════════════════════════
//  POLLING
// ═══════════════════════════════════════════

async function poll() {
  pollingActive = true;
  let consecutiveErrors = 0;
  const MAX_BACKOFF = 5 * 60 * 1000;

  while (pollingActive && !shutdownRequested) {
    try {
      const res = await apiCall('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      consecutiveErrors = 0;
      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          try {
            if (update.message && update.message.text) {
              const msgText = update.message.text;
              if (msgText.startsWith('/')) {
                const cmd = msgText.split(' ')[0].split('@')[0];
                if (handlers[cmd]) {
                  log('info', `[CMD] ${cmd} from ${update.message.from.first_name} (${update.message.from.id})`);
                  handlers[cmd](update.message);
                }
              } else {
                const mapped = menuTextHandlers[msgText];
                if (mapped) {
                  log('info', `[MENU] ${msgText} from ${update.message.from.first_name} (${update.message.from.id})`);
                  const fakeMsg = { ...update.message, text: mapped };
                  const cmd = mapped.split(' ')[0];
                  if (handlers[cmd]) handlers[cmd](fakeMsg);
                } else if (userFlows[update.message.from.id]) {
                  const flow = userFlows[update.message.from.id];
                  if (flow.step === 'submit_url') {
                    delete userFlows[update.message.from.id];
                    delete flowTimestamps[update.message.from.id];
                    const url = msgText.trim();
                    if (!url.startsWith('http://') && !url.startsWith('https://')) {
                      return send(update.message.chat.id, '❌ Please send a valid URL starting with http:// or https://');
                    }
                    const cId = flow.data.challengeId;
                    const user = getOrCreateUser(update.message.from.id, update.message.from.first_name, update.message.from.username);
                    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(cId);
                    if (!challenge) return send(update.message.chat.id, 'Challenge not found.');
                    const existing = db.prepare('SELECT * FROM challenge_submissions WHERE userId = ? AND challengeId = ?').get(user.id, cId);
                    if (existing) return send(update.message.chat.id, 'You already submitted this challenge.');
                    db.prepare('INSERT INTO challenge_submissions (userId, challengeId, solution, githubUrl, completed, pointsAwarded, createdAt) VALUES (?, ?, ?, ?, 0, 0, datetime(\'now\'))').run(user.id, cId, url, url);
                    log('info', `[SUBMIT] ${user.firstName} submitted challenge #${cId}`);
                    send(update.message.chat.id,
                      `✅ <b>Submission Received!</b>\n\n` +
                      `Challenge: <b>${esc(challenge.title)}</b>\n` +
                      `Points: ${challenge.points} SP (pending review)\n\n` +
                      `Your submission is now pending admin review.\n` +
                      `You will be notified once it's approved.`,
                      { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🏆 More Challenges', callback_data: 'nav_challenges' }], [{ text: '🏠 Home', callback_data: 'nav_start' }]] }) }
                    );
                  }
                } else if (adminFlows[update.message.from.id]) {
                  const flow = adminFlows[update.message.from.id];
                  if (flow.step === 'admin_broadcast_text') {
                    if (isAdmin(update.message.from.id)) {
                      delete adminFlows[update.message.from.id];
                      delete flowTimestamps[update.message.from.id];
                      log('info', `[ADMIN] broadcast from ${update.message.from.first_name}`);
                      broadcastWithRateLimit(update.message.chat.id, msgText);
                    }
                  } else {
                    log('info', `[ADMIN] step=${flow.step} from ${update.message.from.first_name}`);
                    handleAdminInput(update.message);
                  }
                }
              }
            } else if (update.callback_query) {
              log('info', `[CB] ${update.callback_query.data} from ${update.callback_query.from.first_name}`);
              handleCallback(update.callback_query);
            }
          } catch (err) {
            log('error', `[UPDATE] ${err.message}`, err.stack);
          }
        }
      }
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(MAX_BACKOFF, Math.pow(2, consecutiveErrors) * 1000);
      log('warn', `[POLL] ${err.code || err.message} (retry in ${Math.round(backoff / 1000)}s, attempt ${consecutiveErrors})`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  pollingActive = false;
  log('info', 'Polling stopped.');
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════

function gracefulShutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  log('info', `${signal} received. Shutting down gracefully...`);
  pollingActive = false;
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    db.close();
    log('info', 'Database connection closed.');
  } catch (e) {
    log('warn', 'Error closing database:', e.message);
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log('error', '[FATAL] Uncaught exception:', err.message, err.stack);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  log('error', '[FATAL] Unhandled rejection:', reason);
});

// ═══════════════════════════════════════════
//  ENTRY
// ═══════════════════════════════════════════

async function main() {
  log('info', 'Starting SkillBridge Bot...');
  log('info', `Environment: ${process.env.NODE_ENV || 'development'}`);
  log('info', `Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'none configured'}`);

  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SkillBridge Bot is running');
  });
  server.listen(PORT, () => {
    log('info', `Health check server listening on port ${PORT}`);
  });

  db.pragma('wal_checkpoint(TRUNCATE)');

  try {
    const syncResult = syncPoolFromFile();
    log('info', `Quiz pool synced: +${syncResult.added} added, ~${syncResult.updated} updated`);
    const stats = getPoolStats();
    log('info', `Quiz pool: ${stats.total} questions across ${stats.byCategory.length} categories (~${stats.daysCovered} days)`);
  } catch (err) {
    log('warn', `Quiz pool sync failed: ${err.message}`);
  }

  try {
    const seedResult = seedChallenges();
    if (seedResult.seeded > 0) log('info', `Challenges seeded: ${seedResult.seeded}`);
  } catch (err) {
    log('warn', `Challenge seed failed: ${err.message}`);
  }

  for (let i = 0; i < 10; i++) {
    try {
      const me = await apiCall('getMe');
      if (me.ok) {
        log('info', `Connected: @${me.result.username}`);
        log('info', 'Polling started.');
        return poll();
      }
      log('warn', `Attempt ${i + 1}/10: getMe failed`);
    } catch (err) {
      log('warn', `Attempt ${i + 1}/10: ${err.code || err.message}`);
    }
    await new Promise(r => setTimeout(r, Math.min(3000 * (i + 1), 30000)));
  }
  log('error', 'Failed to connect after 10 attempts');
  process.exit(1);
}

main().catch(err => {
  log('error', 'Fatal:', err.stack || err);
  process.exit(1);
});

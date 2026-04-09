const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATA FILE PATH ──────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const SIGNUPS_FILE = path.join(DATA_DIR, 'signups.json');

// Ensure data directory and file exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SIGNUPS_FILE)) {
  fs.writeFileSync(SIGNUPS_FILE, JSON.stringify({ plugs: [], clients: [] }, null, 2));
}

// ── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — allow your domain and localhost for dev
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://getplugr.com',
  'https://www.getplugr.com',
  // Add Railway/Render deployment URL here when live
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (Postman, direct curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── HELPERS ─────────────────────────────────────────────────────────────────
function readData() {
  try {
    return JSON.parse(fs.readFileSync(SIGNUPS_FILE, 'utf8'));
  } catch {
    return { plugs: [], clients: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(SIGNUPS_FILE, JSON.stringify(data, null, 2));
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  // Nigerian phone: +234XXXXXXXXXX or 0XXXXXXXXXX
  return /^(\+?234|0)[789]\d{9}$/.test(phone.replace(/\s/g, ''));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/<[^>]*>/g, '').substring(0, 300);
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Plugr backend is live',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── SIGNUP ENDPOINT ──────────────────────────────────────────────────────────
// POST /api/signup
// Body: { type, name, phone, email, location, trade? }
app.post('/api/signup', (req, res) => {
  const { type, name, phone, email, location, trade } = req.body;

  // ── VALIDATION ────────────────────────────────────────────────────────────
  const errors = [];

  if (!type || !['plug', 'client'].includes(type)) {
    errors.push('type must be plug or client');
  }

  if (!name || sanitize(name).length < 2) {
    errors.push('Full name is required');
  }

  if (!phone || !validatePhone(phone.replace(/\s/g, ''))) {
    errors.push('A valid Nigerian WhatsApp number is required');
  }

  if (!email || !validateEmail(email)) {
    errors.push('A valid email address is required');
  }

  if (!location || sanitize(location).length < 2) {
    errors.push('Location in Lagos is required');
  }

  if (type === 'plug' && (!trade || sanitize(trade).length < 2)) {
    errors.push('Trade is required for artisans');
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  // ── DUPLICATE CHECK ───────────────────────────────────────────────────────
  const data = readData();
  const allSignups = [...data.plugs, ...data.clients];
  const duplicate = allSignups.find(
    s => s.email.toLowerCase() === email.toLowerCase() ||
         s.phone.replace(/\s/g, '') === phone.replace(/\s/g, '')
  );

  if (duplicate) {
    return res.status(409).json({
      success: false,
      message: 'This email or phone number is already on the waitlist.',
    });
  }

  // ── STORE ─────────────────────────────────────────────────────────────────
  const entry = {
    id: uuidv4(),
    type,
    name: sanitize(name),
    phone: sanitize(phone),
    email: sanitize(email).toLowerCase(),
    location: sanitize(location),
    ...(type === 'plug' && { trade: sanitize(trade) }),
    signedUpAt: new Date().toISOString(),
    ipAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
  };

  if (type === 'plug') {
    data.plugs.push(entry);
  } else {
    data.clients.push(entry);
  }

  writeData(data);

  // ── RESPONSE ──────────────────────────────────────────────────────────────
  const totalSignups = data.plugs.length + data.clients.length;

  console.log(`[SIGNUP] ${type.toUpperCase()} — ${entry.name} (${entry.email}) — ${new Date().toLocaleString()}`);

  return res.status(201).json({
    success: true,
    message: type === 'plug'
      ? 'You\'re on the list. We\'ll reach out before launch to complete your verification.'
      : 'You\'re on the list. We\'ll notify you when the first Plugs are live in Ikeja.',
    totalSignups,
    whatsappChannel: 'https://whatsapp.com/channel/REPLACE_WITH_YOUR_CHANNEL_LINK',
  });
});

// ── STATS ENDPOINT ─────────────────────────────────────────────────────────
// GET /api/stats — public summary (no personal data)
app.get('/api/stats', (req, res) => {
  const data = readData();
  res.json({
    success: true,
    stats: {
      totalSignups: data.plugs.length + data.clients.length,
      plugs: data.plugs.length,
      clients: data.clients.length,
      lastUpdated: new Date().toISOString(),
    },
  });
});

// ── ADMIN ENDPOINT ─────────────────────────────────────────────────────────
// GET /api/admin/signups?key=YOUR_ADMIN_KEY
// Protected by a simple query param key — replace with a real secret in production
const ADMIN_KEY = process.env.ADMIN_KEY || 'plugr-admin-2026';

app.get('/api/admin/signups', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorised' });
  }

  const data = readData();
  const { type } = req.query;

  if (type === 'plugs') return res.json({ success: true, data: data.plugs, count: data.plugs.length });
  if (type === 'clients') return res.json({ success: true, data: data.clients, count: data.clients.length });

  return res.json({
    success: true,
    data: {
      plugs: data.plugs,
      clients: data.clients,
    },
    count: {
      plugs: data.plugs.length,
      clients: data.clients.length,
      total: data.plugs.length + data.clients.length,
    },
  });
});

// ── 404 HANDLER ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── ERROR HANDLER ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'CORS policy violation' });
  }
  res.status(500).json({ success: false, message: 'Something went wrong on our end' });
});

// ── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Plugr Backend running on port ${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/`);
  console.log(`  Stats:   http://localhost:${PORT}/api/stats`);
  console.log(`  Admin:   http://localhost:${PORT}/api/admin/signups?key=${ADMIN_KEY}`);
  console.log(`  Signup:  POST http://localhost:${PORT}/api/signup\n`);
});

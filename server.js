const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'appointments.json');

const DEFAULT_SLOTS = [
  '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30',
  '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}
function readAppointments() {
  ensureDataFile();
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function writeAppointments(items) {
  ensureDataFile();
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}
function todayInOman() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Muscat', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= todayInOman(); }
function validTime(time) { return DEFAULT_SLOTS.includes(time); }
function escapeHtml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 200_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, headers = {}) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': data.length,
    ...headers
  });
  res.end(data);
}

function commonHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self';"
  };
}

function smtpResponse(socket, expectedCodes = []) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let timer;
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); };
    const finish = (error, text) => { cleanup(); error ? reject(error) : resolve(text); };
    const onError = err => finish(err);
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (!expectedCodes.includes(code)) return finish(new Error(`SMTP ${code}: ${line}`));
        return finish(null, line);
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    timer = setTimeout(() => finish(new Error('SMTP timeout')), 15_000);
  });
}

function smtpCommand(socket, command, expectedCodes = []) {
  const pending = smtpResponse(socket, expectedCodes);
  socket.write(command + '\r\n');
  return pending;
}

async function sendGmailSmtp({ from, to, replyTo, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || 'true') === 'true';
  if (!secure) throw new Error('This built-in SMTP sender expects SMTPS on port 465. Set SMTP_SECURE=true.');

  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await smtpResponse(socket, [220]);
    await smtpCommand(socket, 'EHLO localhost', [250]);
    await smtpCommand(socket, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, Buffer.from(process.env.SMTP_USER, 'utf8').toString('base64'), [334]);
    await smtpCommand(socket, Buffer.from(process.env.SMTP_PASS, 'utf8').toString('base64'), [235]);
    await smtpCommand(socket, `MAIL FROM:<${from}>`, [250]);
    for (const recipient of to) await smtpCommand(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    await smtpCommand(socket, 'DATA', [354]);
    const headers = [
      `From: "${process.env.MAIL_FROM_NAME || 'Zakir Parkar Architecture'}" <${from}>`,
      `To: ${to.join(', ')}`,
      `Reply-To: ${replyTo}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit'
    ].join('\r\n');
    const safeBody = html.replace(/^\./gm, '..');
    await smtpCommand(socket, `${headers}\r\n\r\n${safeBody}\r\n.`, [250]);
    await smtpCommand(socket, 'QUIT', [221]);
    return true;
  } finally {
    socket.end();
  }
}


function postTwilioMessage({ to, from, body, contentSid, contentVariables }) {
  return new Promise((resolve, reject) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token || !to || !from) return reject(new Error('WhatsApp/Twilio is not configured.'));

    const params = new URLSearchParams();
    params.set('To', to.startsWith('whatsapp:') ? to : `whatsapp:${to}`);
    params.set('From', from.startsWith('whatsapp:') ? from : `whatsapp:${from}`);
    if (contentSid) {
      params.set('ContentSid', contentSid);
      params.set('ContentVariables', JSON.stringify(contentVariables || {}));
    } else if (body) {
      params.set('Body', body);
    }

    const request = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      method: 'POST',
      auth: `${sid}:${token}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params.toString())
      }
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk.toString('utf8'); });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok:true }); }
        } else {
          let detail = data;
          try { detail = JSON.parse(data).message || detail; } catch {}
          reject(new Error(`Twilio ${response.statusCode}: ${detail}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Twilio timeout')));
    request.write(params.toString());
    request.end();
  });
}

async function sendWhatsAppNotification(b) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.WHATSAPP_TO || !process.env.WHATSAPP_FROM) return false;
  const detail = [
    `Client: ${b.name}`,
    `Phone: ${b.phone}`,
    `Email: ${b.email}`,
    `Service: ${b.service}`,
    `Project: ${b.projectType}`,
    `Date: ${b.date}`,
    `Time: ${b.time} (Oman time)`,
    `Message: ${b.message || '—'}`,
    `Booking ID: ${b.id}`
  ].join('\n');
  await postTwilioMessage({
    to: process.env.WHATSAPP_TO,
    from: process.env.WHATSAPP_FROM,
    body: `New appointment request — Zakir Parkar Architecture\n\n${detail}`,
    contentSid: process.env.WHATSAPP_CONTENT_SID || '',
    contentVariables: { 1: detail }
  });
  return true;
}

function notificationHtml(b) {
  const rows = [
    ['Client', b.name], ['Email', b.email], ['Phone', b.phone], ['Service', b.service],
    ['Date', b.date], ['Time', b.time], ['Project', b.projectType], ['Message', b.message || '—']
  ];
  return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:auto;color:#1e1e1e"><div style="padding:24px 0;border-bottom:1px solid #ddd"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8b6f47">New consultation request</div><h1 style="margin:8px 0 0;font-size:28px">Zakir Parkar Architecture</h1></div><div style="padding:24px 0"><table style="width:100%;border-collapse:collapse">${rows.map(([k,v])=>`<tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;width:32%">${escapeHtml(k)}</td><td style="padding:10px 0;border-bottom:1px solid #eee"><strong>${escapeHtml(v)}</strong></td></tr>`).join('')}</table></div><p style="font-size:12px;color:#777">Booking ID: ${escapeHtml(b.id)}</p></div>`;
}
function confirmationHtml(b) {
  return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:auto;color:#1e1e1e"><h2>Appointment request received</h2><p>Thank you, ${escapeHtml(b.name)}. Your consultation request has been received for <strong>${escapeHtml(b.date)} at ${escapeHtml(b.time)}</strong>.</p><p>This is a request rather than a final confirmed appointment. Zakir Parkar will contact you using the details provided.</p><div style="padding:18px;background:#f5f2ec;margin:22px 0"><strong>${escapeHtml(b.service)}</strong><br>${escapeHtml(b.projectType)}</div><p>For urgent enquiries, call or WhatsApp <a href="tel:+96892118458">+968 92118458</a>.</p><p style="color:#777;font-size:12px">Zakir Parkar - Architectural Design &amp; Visualization</p></div>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const headers = commonHeaders();

  if (pathname === '/api/availability' && req.method === 'GET') {
    const date = String(url.searchParams.get('date') || '');
    if (!validDate(date)) return send(res, 400, { ok:false, error:'Choose a valid date.' }, headers);
    const booked = new Set(readAppointments().filter(a => a.date === date).map(a => a.time));
    return send(res, 200, { ok:true, slots:DEFAULT_SLOTS.map(time => ({ time, available:!booked.has(time) })) }, headers);
  }

  if (pathname === '/api/appointments' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return send(res, 400, { ok:false, error:e.message }, headers); }
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const service = String(body.service || '').trim();
    const projectType = String(body.projectType || '').trim();
    const date = String(body.date || '').trim();
    const time = String(body.time || '').trim();
    const message = String(body.message || '').trim().slice(0, 2000);

    if (!name || name.length < 2) return send(res, 400, { ok:false, error:'Please enter your name.' }, headers);
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { ok:false, error:'Please enter a valid email.' }, headers);
    if (phone.length < 7) return send(res, 400, { ok:false, error:'Please enter a valid phone number.' }, headers);
    if (!service) return send(res, 400, { ok:false, error:'Please choose a service.' }, headers);
    if (!projectType) return send(res, 400, { ok:false, error:'Please choose a project type.' }, headers);
    if (!validDate(date)) return send(res, 400, { ok:false, error:'Please choose a future date.' }, headers);
    if (!validTime(time)) return send(res, 400, { ok:false, error:'Please choose an available time.' }, headers);

    const appointments = readAppointments();
    if (appointments.some(a => a.date === date && a.time === time)) return send(res, 409, { ok:false, error:'That time has just been booked. Please choose another slot.' }, headers);

    const booking = { id:crypto.randomUUID().slice(0,8).toUpperCase(), name,email,phone,service,projectType,date,time,message,createdAt:new Date().toISOString() };
    appointments.push(booking);
    writeAppointments(appointments);

    const recipients = (process.env.NOTIFY_EMAILS || 'aymanzakir28@gmail.com,zparkar1@gmail.com').split(',').map(v=>v.trim()).filter(Boolean);
    let emailSent = false;
    let whatsappSent = false;
    if (process.env.SMTP_USER && process.env.SMTP_PASS && recipients.length) {
      try {
        emailSent = await sendGmailSmtp({ from:process.env.SMTP_USER, to:recipients, replyTo:email, subject:`New appointment request - ${name} - ${date} ${time}`, html:notificationHtml(booking) });
        await sendGmailSmtp({ from:process.env.SMTP_USER, to:[email], replyTo:process.env.SMTP_USER, subject:'Appointment request received - Zakir Parkar Architecture', html:confirmationHtml(booking) });
      } catch (err) {
        console.error('Email error:', err.message);
      }
    } else {
      console.log('SMTP not configured; booking saved:', booking.id);
    }

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.WHATSAPP_TO && process.env.WHATSAPP_FROM) {
      try {
        whatsappSent = await sendWhatsAppNotification(booking);
      } catch (err) {
        console.error('WhatsApp error:', err.message);
      }
    } else {
      console.log('WhatsApp/Twilio not configured; booking saved:', booking.id);
    }

    return send(res, 200, { ok:true, bookingId:booking.id, emailSent, whatsappSent }, headers);
  }

  if (pathname === '/api/health') return send(res, 200, { ok:true, emailConfigured:Boolean(process.env.SMTP_USER && process.env.SMTP_PASS), whatsappConfigured:Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.WHATSAPP_TO && process.env.WHATSAPP_FROM), todayInOman:todayInOman() }, headers);

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok:false, error:'Method not allowed' }, headers);

  let filePath = pathname === '/' ? path.join(PUBLIC_DIR,'index.html') : path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', headers);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath,'index.html');
    if (!fs.existsSync(filePath)) throw new Error('not found');
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    headers['Content-Type'] = contentType;
    headers['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=604800, immutable';
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    const data = fs.readFileSync(filePath);
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    const fallback = fs.readFileSync(path.join(PUBLIC_DIR,'index.html'));
    headers['Content-Type'] = 'text/html; charset=utf-8';
    headers['Content-Length'] = fallback.length;
    res.writeHead(200, headers);
    res.end(fallback);
  }
}

ensureDataFile();
const server = http.createServer((req,res) => {
  handle(req,res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { ok:false, error:'Server error' }, commonHeaders());
    else res.end();
  });
});
server.listen(PORT, () => console.log(`Zakir Parkar website running on http://localhost:${PORT}`));

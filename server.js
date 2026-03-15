const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ADMIN_CODE = process.env.ADMIN_CODE;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CREATOR_ROLE_ID = process.env.CREATOR_ROLE_ID;
const CREATOR_USER_ID = process.env.CREATOR_USER_ID;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean);

const DATA_FILE = path.join(__dirname, 'candidatures.json');

app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function loadCandidatures() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveCandidatures(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function sendWebhook(entry) {
  try {
    await axios.post(WEBHOOK_URL, {
      embeds: [{
        title: '📋 Nouvelle candidature modérateur',
        color: 0x5865f2,
        thumbnail: { url: entry.discordAvatar },
        fields: [
          { name: '👤 Discord', value: entry.discordUsername, inline: true },
          { name: '🎮 Pseudo Roblox', value: entry.reponses.pseudo_roblox || '—', inline: true },
          { name: '🎂 Âge', value: String(entry.reponses.age || '—'), inline: true },
          { name: '⏱️ Temps de jeu', value: entry.reponses.temps_jeu || '—', inline: true },
          { name: '🕐 Heures / semaine', value: entry.reponses.heures_semaine || '—', inline: true },
          { name: '💬 Motivation', value: (entry.reponses.motivation || '—').slice(0, 300) },
        ],
        footer: { text: 'Vax RP — Emergency Hamburg' },
        timestamp: entry.date
      }]
    });
  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
}

app.get('/auth/discord', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds.members.read`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    // Récupère les rôles du membre dans le serveur
    let memberRoles = [];
    try {
      const memberRes = await axios.get(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      memberRoles = memberRes.data.roles || [];
    } catch {}

    const isCreator = memberRoles.includes(CREATOR_ROLE_ID) || userRes.data.id === CREATOR_USER_ID;
    const isAdmin = ADMIN_USER_IDS.includes(userRes.data.id);

    // Vérifie si banni
    const bans = loadBans();
    if (bans.find(b => b.discordId === userRes.data.id)) {
      req.session.user = { id: userRes.data.id, username: userRes.data.username, avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png` };
      return res.redirect('/banni.html');
    }
    req.session.user = {
      id: userRes.data.id,
      username: userRes.data.username,
      avatar: userRes.data.avatar
        ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
      isCreator,
      isAdmin,
      roleName: isCreator ? 'Créateur' : isAdmin ? 'Admin' : null,
      roleColor: isCreator ? '#fbbf24' : isAdmin ? '#f87171' : null
    };

    // Récupère le nom + couleur du rôle principal via le bot (seulement si pas déjà défini)
    if (!req.session.user.roleName) {
      try {
        const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/roles`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        const allRoles = rolesRes.data.sort((a, b) => b.position - a.position);
        const topRole = allRoles.find(r => memberRoles.includes(r.id) && r.name !== '@everyone');
        if (topRole) {
          req.session.user.roleName = topRole.name;
          req.session.user.roleColor = topRole.color ? '#' + topRole.color.toString(16).padStart(6, '0') : '#8b949e';
        } else {
          req.session.user.roleName = 'Membre';
          req.session.user.roleColor = '#8b949e';
        }
      } catch {
        req.session.user.roleName = 'Membre';
        req.session.user.roleColor = '#8b949e';
      }
    }
    // Sauvegarde les infos admin si c'est un admin
    if (isAdmin) {
      const admins = loadAdminsList();
      const idx = admins.findIndex(a => a.id === userRes.data.id);
      const adminInfo = { id: userRes.data.id, username: userRes.data.username, avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png`, lastSeen: new Date().toISOString() };
      if (idx >= 0) admins[idx] = adminInfo; else admins.push(adminInfo);
      saveAdminsList(admins);
    }

    res.redirect('/form.html');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'Non connecté' });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.post('/api/candidature', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const candidatures = loadCandidatures();
  const already = candidatures.find(c => c.discordId === req.session.user.id);
  if (already) return res.status(400).json({ error: 'Tu as déjà soumis une candidature.' });
  const entry = {
    id: Date.now(),
    discordId: req.session.user.id,
    discordUsername: req.session.user.username,
    discordAvatar: req.session.user.avatar,
    date: new Date().toISOString(),
    reponses: req.body
  };
  candidatures.push(entry);
  saveCandidatures(candidatures);
  await sendWebhook(entry);
  res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.code === ADMIN_CODE) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Code incorrect' });
  }
});

app.get('/api/admin/candidatures', (req, res) => {
  const ok = req.session.isAdmin || req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  res.json(loadCandidatures());
});

// Panel créateur — vérifie le rôle Discord OU l'ID utilisateur
app.get('/api/creator/check', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const ok = req.session.user.isCreator || req.session.user.id === CREATOR_USER_ID || req.session.user.isAdmin || ADMIN_USER_IDS.includes(req.session.user.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  res.json({ ok: true });
});

app.get('/api/creator/candidatures', (req, res) => {
  const ok = req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  res.json(loadCandidatures());
});

app.delete('/api/creator/candidature/:id', (req, res) => {
  const ok = req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  saveCandidatures(loadCandidatures().filter(c => c.id !== parseInt(req.params.id)));
  res.json({ success: true });
});

// Staff — membres du serveur Discord avec rôles
app.get('/api/staff', async (req, res) => {
  try {
    const membersRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=100`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const allRoles = rolesRes.data;
    const members = membersRes.data
      .filter(m => !m.user.bot && m.roles.length > 0)
      .map(m => {
        const memberRoles = m.roles
          .map(rid => allRoles.find(r => r.id === rid))
          .filter(r => r && r.name !== '@everyone')
          .sort((a, b) => b.position - a.position);
        return {
          id: m.user.id,
          username: m.nick || m.user.global_name || m.user.username,
          avatar: m.user.avatar
            ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/0.png`,
          roles: memberRoles.map(r => ({ id: r.id, name: r.name, color: r.color }))
        };
      })
      .filter(m => m.roles.length > 0);
    res.json(members);
  } catch (err) {
    console.error('Staff error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Impossible de charger les membres. Vérifie le Server Members Intent.' });
  }
});

app.post('/api/admin/candidature/:id/statut', (req, res) => {
  const ok = req.session.isAdmin || req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  const id = parseInt(req.params.id);
  const { statut, message } = req.body;
  const candidatures = loadCandidatures();
  const c = candidatures.find(c => c.id === id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  c.statut = statut;
  c.messageStatut = message || '';
  saveCandidatures(candidatures);
  res.json({ success: true });
});

app.get('/api/ma-candidature', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const candidatures = loadCandidatures();
  const c = candidatures.find(c => c.discordId === req.session.user.id);
  if (!c) return res.status(404).json({ error: 'Aucune candidature' });
  res.json({ statut: c.statut || 'en_attente', message: c.messageStatut || '', date: c.date, pseudo: c.reponses.pseudo_roblox });
});

app.delete('/api/admin/candidature/:id', (req, res) => {
  const ok = req.session.isAdmin || req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  const id = parseInt(req.params.id);
  saveCandidatures(loadCandidatures().filter(c => c.id !== id));
  res.json({ success: true });
});

const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const BANS_FILE = path.join(__dirname, 'bans.json');
if (!fs.existsSync(BANS_FILE)) fs.writeFileSync(BANS_FILE, '[]');
function loadBans() { return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')); }
function saveBans(data) { fs.writeFileSync(BANS_FILE, JSON.stringify(data, null, 2)); }

const ADMINS_FILE = path.join(__dirname, 'admins.json');
if (!fs.existsSync(ADMINS_FILE)) fs.writeFileSync(ADMINS_FILE, '[]');
function loadAdminsList() { return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')); }
function saveAdminsList(data) { fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2)); }

function isStaff(req) {
  return req.session.isAdmin || req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
}

app.get('/api/admins', (req, res) => {
  if (req.session.user?.id !== CREATOR_USER_ID) return res.status(403).json({ error: 'Accès refusé' });
  res.json(loadAdminsList());
});

app.get('/api/mon-ban', (req, res) => {
  if (!req.session.user) return res.status(401).json({});
  const ban = loadBans().find(b => b.discordId === req.session.user.id);
  if (!ban) return res.status(404).json({});
  res.json(ban);
});

app.get('/api/bans', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(loadBans());
});

app.post('/api/ban', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  const { discordId, discordUsername, discordAvatar, raison } = req.body;
  if (!discordId) return res.status(400).json({ error: 'ID manquant' });
  const bans = loadBans();
  if (bans.find(b => b.discordId === discordId)) return res.status(400).json({ error: 'Déjà banni' });
  bans.push({ discordId, discordUsername, discordAvatar, raison: raison || '', bannePar: req.session.user?.username || 'Admin', date: new Date().toISOString() });
  saveBans(bans);
  res.json({ success: true });
});

app.delete('/api/ban/:id', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  saveBans(loadBans().filter(b => b.discordId !== req.params.id));
  res.json({ success: true });
});
if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, '[]');
function loadTickets() { return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')); }
function saveTickets(data) { fs.writeFileSync(TICKETS_FILE, JSON.stringify(data, null, 2)); }

app.post('/api/ticket', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const { categorie, sujet, description } = req.body;
  if (!categorie || !sujet || !description) return res.status(400).json({ error: 'Champs manquants' });
  const ticket = {
    id: Date.now(),
    discordId: req.session.user.id,
    discordUsername: req.session.user.username,
    discordAvatar: req.session.user.avatar,
    categorie, sujet, description,
    statut: 'ouvert',
    date: new Date().toISOString(),
    reponses: []
  };
  const tickets = loadTickets();
  tickets.push(ticket);
  saveTickets(tickets);
  try {
    await axios.post(WEBHOOK_URL, { embeds: [{ title: '🎫 Nouveau ticket', color: 0x3b82f6,
      fields: [
        { name: '👤 Utilisateur', value: ticket.discordUsername, inline: true },
        { name: '📂 Catégorie', value: ticket.categorie, inline: true },
        { name: '📝 Sujet', value: ticket.sujet },
        { name: '💬 Description', value: ticket.description.slice(0, 300) }
      ], footer: { text: 'Vax RP — Tickets' }, timestamp: ticket.date }] });
  } catch {}
  res.json({ success: true, id: ticket.id });
});

app.get('/api/mes-tickets', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  res.json(loadTickets().filter(t => t.discordId === req.session.user.id));
});

app.get('/api/admin/tickets', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(loadTickets());
});

app.post('/api/ticket/:id/message', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const tickets = loadTickets();
  const t = tickets.find(t => t.id === parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Introuvable' });
  if (t.discordId !== req.session.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (t.statut === 'ferme') return res.status(400).json({ error: 'Ticket fermé' });
  t.reponses.push({
    message: req.body.message,
    date: new Date().toISOString(),
    staff: req.session.user.username,
    avatar: req.session.user.avatar || '',
    roleName: req.session.user.roleName || 'Membre',
    roleColor: req.session.user.roleColor || '#8b949e',
    isUser: true
  });
  saveTickets(tickets);
  res.json({ success: true });
});

app.post('/api/admin/ticket/:id/repondre', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  const tickets = loadTickets();
  const t = tickets.find(t => t.id === parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Introuvable' });
  t.reponses.push({
    message: req.body.message,
    date: new Date().toISOString(),
    staff: req.session.user?.username || 'Admin',
    avatar: req.session.user?.avatar || '',
    roleName: req.session.user?.roleName || 'Staff',
    roleColor: req.session.user?.roleColor || '#8b949e',
    isUser: false
  });
  t.statut = req.body.statut || t.statut;
  saveTickets(tickets);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`✅ Serveur lancé sur http://localhost:${PORT}`));

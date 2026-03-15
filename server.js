const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { MongoClient } = require('mongodb');
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
const MONGO_URI = process.env.MONGO_URI;

let db;
MongoClient.connect(MONGO_URI).then(client => {
  db = client.db('vaxrp');
  console.log('✅ MongoDB connecté');
}).catch(err => console.error('MongoDB error:', err));

app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

function isStaff(req) {
  return req.session.isAdmin || req.session.user?.isCreator || req.session.user?.id === CREATOR_USER_ID || req.session.user?.isAdmin || ADMIN_USER_IDS.includes(req.session.user?.id);
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
      new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });

    let memberRoles = [];
    try {
      const memberRes = await axios.get(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, { headers: { Authorization: `Bearer ${accessToken}` } });
      memberRoles = memberRes.data.roles || [];
    } catch {}

    const isCreator = memberRoles.includes(CREATOR_ROLE_ID) || userRes.data.id === CREATOR_USER_ID;
    const isAdmin = ADMIN_USER_IDS.includes(userRes.data.id);

    const ban = await db.collection('bans').findOne({ discordId: userRes.data.id });
    if (ban) {
      req.session.user = { id: userRes.data.id, username: userRes.data.username, avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png` };
      return res.redirect('/banni.html');
    }

    req.session.user = {
      id: userRes.data.id,
      username: userRes.data.username,
      avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png`,
      isCreator, isAdmin,
      roleName: isCreator ? 'Créateur' : isAdmin ? 'Admin' : null,
      roleColor: isCreator ? '#fbbf24' : isAdmin ? '#f87171' : null
    };

    if (!req.session.user.roleName) {
      try {
        const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        const allRoles = rolesRes.data.sort((a, b) => b.position - a.position);
        const topRole = allRoles.find(r => memberRoles.includes(r.id) && r.name !== '@everyone');
        req.session.user.roleName = topRole ? topRole.name : 'Membre';
        req.session.user.roleColor = topRole?.color ? '#' + topRole.color.toString(16).padStart(6, '0') : '#8b949e';
      } catch {
        req.session.user.roleName = 'Membre';
        req.session.user.roleColor = '#8b949e';
      }
    }

    if (isAdmin) {
      const adminInfo = { id: userRes.data.id, username: userRes.data.username, avatar: req.session.user.avatar, lastSeen: new Date().toISOString() };
      await db.collection('admins').updateOne({ id: userRes.data.id }, { $set: adminInfo }, { upsert: true });
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

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Candidatures
app.post('/api/candidature', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const already = await db.collection('candidatures').findOne({ discordId: req.session.user.id });
  if (already) return res.status(400).json({ error: 'Tu as déjà soumis une candidature.' });
  const entry = { id: Date.now(), discordId: req.session.user.id, discordUsername: req.session.user.username, discordAvatar: req.session.user.avatar, date: new Date().toISOString(), reponses: req.body };
  await db.collection('candidatures').insertOne(entry);
  await sendWebhook(entry);
  res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.code === ADMIN_CODE) { req.session.isAdmin = true; res.json({ success: true }); }
  else res.status(403).json({ error: 'Code incorrect' });
});

app.get('/api/admin/candidatures', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(await db.collection('candidatures').find().toArray());
});

app.get('/api/creator/check', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json({ ok: true });
});

app.get('/api/creator/candidatures', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(await db.collection('candidatures').find().toArray());
});

app.delete('/api/creator/candidature/:id', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  await db.collection('candidatures').deleteOne({ id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.post('/api/admin/candidature/:id/statut', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  const { statut, message } = req.body;
  await db.collection('candidatures').updateOne({ id: parseInt(req.params.id) }, { $set: { statut, messageStatut: message || '' } });
  res.json({ success: true });
});

app.get('/api/ma-candidature', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const c = await db.collection('candidatures').findOne({ discordId: req.session.user.id });
  if (!c) return res.status(404).json({ error: 'Aucune candidature' });
  res.json({ statut: c.statut || 'en_attente', message: c.messageStatut || '', date: c.date, pseudo: c.reponses.pseudo_roblox });
});

app.delete('/api/admin/candidature/:id', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  await db.collection('candidatures').deleteOne({ id: parseInt(req.params.id) });
  res.json({ success: true });
});

// Bans
app.get('/api/mon-ban', async (req, res) => {
  if (!req.session.user) return res.status(401).json({});
  const ban = await db.collection('bans').findOne({ discordId: req.session.user.id });
  if (!ban) return res.status(404).json({});
  res.json(ban);
});

app.get('/api/bans', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(await db.collection('bans').find().toArray());
});

app.post('/api/ban', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  const { discordId, discordUsername, discordAvatar, raison } = req.body;
  if (!discordId) return res.status(400).json({ error: 'ID manquant' });
  const exists = await db.collection('bans').findOne({ discordId });
  if (exists) return res.status(400).json({ error: 'Déjà banni' });
  await db.collection('bans').insertOne({ discordId, discordUsername, discordAvatar, raison: raison || '', bannePar: req.session.user?.username || 'Admin', date: new Date().toISOString() });
  res.json({ success: true });
});

app.delete('/api/ban/:id', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  await db.collection('bans').deleteOne({ discordId: req.params.id });
  res.json({ success: true });
});

// Admins
app.get('/api/admins', async (req, res) => {
  if (req.session.user?.id !== CREATOR_USER_ID) return res.status(403).json({ error: 'Accès refusé' });
  res.json(await db.collection('admins').find().toArray());
});

// Staff Discord
app.get('/api/staff', async (req, res) => {
  try {
    const membersRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=100`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    const rolesRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    const allRoles = rolesRes.data;
    const members = membersRes.data
      .filter(m => !m.user.bot && m.roles.length > 0)
      .map(m => {
        const memberRoles = m.roles.map(rid => allRoles.find(r => r.id === rid)).filter(r => r && r.name !== '@everyone').sort((a, b) => b.position - a.position);
        return { id: m.user.id, username: m.nick || m.user.global_name || m.user.username, avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png`, roles: memberRoles.map(r => ({ id: r.id, name: r.name, color: r.color })) };
      }).filter(m => m.roles.length > 0);
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: 'Impossible de charger les membres.' });
  }
});

// Tickets
app.post('/api/ticket', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const { categorie, sujet, description } = req.body;
  if (!categorie || !sujet || !description) return res.status(400).json({ error: 'Champs manquants' });
  const ticket = { id: Date.now(), discordId: req.session.user.id, discordUsername: req.session.user.username, discordAvatar: req.session.user.avatar, categorie, sujet, description, statut: 'ouvert', date: new Date().toISOString(), reponses: [] };
  await db.collection('tickets').insertOne(ticket);
  try {
    await axios.post(WEBHOOK_URL, { embeds: [{ title: '🎫 Nouveau ticket', color: 0x3b82f6, fields: [{ name: '👤 Utilisateur', value: ticket.discordUsername, inline: true }, { name: '📂 Catégorie', value: ticket.categorie, inline: true }, { name: '📝 Sujet', value: ticket.sujet }, { name: '💬 Description', value: ticket.description.slice(0, 300) }], footer: { text: 'Vax RP — Tickets' }, timestamp: ticket.date }] });
  } catch {}
  res.json({ success: true, id: ticket.id });
});

app.get('/api/mes-tickets', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  res.json(await db.collection('tickets').find({ discordId: req.session.user.id }).toArray());
});

app.get('/api/admin/tickets', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(await db.collection('tickets').find().toArray());
});

app.post('/api/ticket/:id/message', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const ticket = await db.collection('tickets').findOne({ id: parseInt(req.params.id) });
  if (!ticket) return res.status(404).json({ error: 'Introuvable' });
  if (ticket.discordId !== req.session.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (ticket.statut === 'ferme') return res.status(400).json({ error: 'Ticket fermé' });
  await db.collection('tickets').updateOne({ id: parseInt(req.params.id) }, { $push: { reponses: { message: req.body.message, date: new Date().toISOString(), staff: req.session.user.username, avatar: req.session.user.avatar || '', roleName: req.session.user.roleName || 'Membre', roleColor: req.session.user.roleColor || '#8b949e', isUser: true } } });
  res.json({ success: true });
});

app.post('/api/admin/ticket/:id/repondre', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Accès refusé' });
  await db.collection('tickets').updateOne({ id: parseInt(req.params.id) }, { $push: { reponses: { message: req.body.message, date: new Date().toISOString(), staff: req.session.user?.username || 'Admin', avatar: req.session.user?.avatar || '', roleName: req.session.user?.roleName || 'Staff', roleColor: req.session.user?.roleColor || '#8b949e', isUser: false } }, $set: { statut: req.body.statut || 'ouvert' } });
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`✅ Serveur lancé sur http://localhost:${PORT}`));

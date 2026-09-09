const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

// Povezivanje sa PostgreSQL bazom podataka
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Obavezno za Render/Neon/Supabase besplatne baze
});

// --- RUTE ZA AUTENTIFIKACIJU ---

// Registracija
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, passwordHash]
    );

    res.status(201).json(newUser.rows[0]);
  } catch (err) {
    res.status(400).json({ error: "Korisničko ime ili email već postoje." });
  }
});

// Logovanje
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(400).json({ error: "Pogrešni kredencijali." });

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: "Pogrešni kredencijali." });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: "Serverska greška." });
  }
});

// --- WEBSOCKET LOGIKA (SOCKET.IO) ---
io.on('connection', (socket) => {
  console.log(`Korisnik povezan: ${socket.id}`);

  // Pridruživanje stolu / sobi
  socket.on('join_game', ({ gameId, username }) => {
    socket.join(`game_${gameId}`);
    console.log(`${username} se pridružio igri ${gameId}`);
    io.to(`game_${gameId}`).emit('player_joined', { username, msg: `${username} je ušao u igru.` });
  });

  // Simulacija odigravanja karte u preferansu
  socket.on('play_card', ({ gameId, player, card }) => {
    // Ovde se kasnije dodaje provera pravila preferansa (boja, adut, sečenje...)
    console.log(`Igra u sobi ${gameId}: ${player} je bacio ${card}`);
    io.to(`game_${gameId}`).emit('card_played', { player, card });
  });

  socket.on('disconnect', () => {
    console.log(`Korisnik odjavljen: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server pokrenut na portu ${PORT}`));

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

// --- KREIRANJE SOBA ZA PREFERANS ---
let activeRooms = {}; // Čuva stanje svih stolova/soba
let waitingPlayers = []; // Lista igrača koji čekaju slobodno mesto

io.on('connection', (socket) => {
    // Provera da li je korisnik ulogovan (preko JWT-a prosleđenog pri konekciji)
    const username = socket.handshake.auth.username || "Gost_" + socket.id.substring(0, 4);
    console.log(`♣️ Igrač ${username} se povezao na server.`);

    // 1. Kada igrač zatraži da se pridruži stolu
    socket.on('join_table', () => {
        // Provera da li je igrač već u redu za čekanje
        if (waitingPlayers.some(p => p.username === username)) return;

        waitingPlayers.push({ id: socket.id, username: username, socket: socket });
        console.log(`👥 ${username} čeka suigrače. Ukupno u čekanju: ${waitingPlayers.length}`);

        // 2. Kada imamo tačno 3 igrača u redu, kreiramo sobu i spajamo ih
        if (waitingPlayers.length >= 3) {
            const roomId = 'room_' + Date.now(); // Jedinstveni ID sobe
            const playersForThisRoom = waitingPlayers.splice(0, 3); // Uzimamo prva 3 igrača

            activeRooms[roomId] = {
                id: roomId,
                players: playersForThisRoom.map(p => ({ id: p.id, username: p.username })),
                gameState: 'waiting_to_start'
            };

            // Spajamo sva tri igrača u Socket.io "room" i šaljemo im signal
            playersForThisRoom.forEach((player, index) => {
                player.socket.join(roomId);
                
                // Šaljemo svakom igraču informaciju o sobi i ko su mu suigrači
                player.socket.emit('game_ready', {
                    roomId: roomId,
                    mySeat: index + 1, // Pozicija 1, 2 ili 3 za stolom
                    allPlayers: activeRooms[roomId].players
                });
            });

            console.log(`🚀 Igra je spremna u sobi ${roomId}! Igrači: ${activeRooms[roomId].players.map(p=>p.username).join(', ')}`);
        } else {
            // Ako nema dovoljno igrača, obaveštavamo trenutnog igrača da čeka
            socket.emit('waiting_for_players', { count: waitingPlayers.length });
        }
    });

    // 3. Logika za prekid veze (ako igrač izađe pre nego što igra počne)
    socket.on('disconnect', () => {
        console.log(`❌ Korisnik ${username} je prekinuo vezu.`);
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        
        // (Opciono): Ovde kasnije možemo dodati i logiku ako igrač pobegne usred partije
    });
});


const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Srednji slojevi (Middleware)
app.use(cors());
app.use(express.json());

// Konekcija sa bazom podataka (Neon.tech)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Provera konekcije sa bazom pri pokretanju
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Greška pri povezivanju sa PostgreSQL bazom:', err.stack);
    }
    console.log('Uspešno povezan sa Neon PostgreSQL bazom podataka!');
    release();
});

// ==========================================
//  RUTE ZA AUTENTIFIKACIJU
// ==========================================

// 1. Registracija korisnika
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        // Provera da li korisnik već postoji
        const userExists = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: 'Korisničko ime ili email su već zauzeti.' });
        }

        // Heširanje lozinke radi bezbednosti
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Upis u bazu
        await pool.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
            [username, email, hashedPassword]
        );

        res.status(201).json({ message: 'Uspešna registracija!' });
    } catch (err) {
        console.error('Greška pri registraciji:', err);
        res.status(500).json({ message: 'Greška na serveru pri registraciji.' });
    }
});

// 2. Logovanje korisnika
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(400).json({ message: 'Neispravno korisničko ime ili lozinka.' });
        }

        const user = result.rows[0];
        
        // Provera lozinke
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Neispravno korisničko ime ili lozinka.' });
        }

        // Kreiranje tokena (JWT)
        const secret = process.env.JWT_SECRET || 'moja_tajna_rec';
        const token = jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '24h' });

        res.json({ token, username: user.username });
    } catch (err) {
        console.error('Greška pri prijavi:', err);
        res.status(500).json({ message: 'Greška na serveru pri prijavi.' });
    }
});

// ==========================================
//  SOCKET.IO LOGIKA (Sobe i igrači)
// ==========================================
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

let activeRooms = {}; // Čuva stanje svih stolova/soba
let waitingPlayers = []; // Lista igrača koji čekaju slobodno mesto

io.on('connection', (socket) => {
    const username = socket.handshake.auth.username || "Gost_" + socket.id.substring(0, 4);
    console.log(`♣️ Igrač ${username} se povezao na server.`);

    // Kada igrač zatraži da se pridruži stolu
    socket.on('join_table', () => {
        if (waitingPlayers.some(p => p.username === username)) return;

        waitingPlayers.push({ id: socket.id, username: username, socket: socket });
        console.log(`👥 ${username} čeka suigrače. Ukupno u čekanju: ${waitingPlayers.length}`);

        // Kada imamo tačno 3 igrača u redu, kreiramo sobu i spajamo ih
        if (waitingPlayers.length >= 3) {
            const roomId = 'room_' + Date.now(); 
            const playersForThisRoom = waitingPlayers.splice(0, 3); 

            activeRooms[roomId] = {
                id: roomId,
                players: playersForThisRoom.map(p => ({ id: p.id, username: p.username })),
                gameState: 'waiting_to_start'
            };

            // Spajamo sva tri igrača u Socket.io "room" i šaljemo im signal
            playersForThisRoom.forEach((player, index) => {
                player.socket.join(roomId);
                
                player.socket.emit('game_ready', {
                    roomId: roomId,
                    mySeat: index + 1, 
                    allPlayers: activeRooms[roomId].players
                });
            });

            console.log(`🚀 Igra je spremna u sobi ${roomId}! Igrači: ${activeRooms[roomId].players.map(p=>p.username).join(', ')}`);
        } else {
            socket.emit('waiting_for_players', { count: waitingPlayers.length });
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Korisnik ${username} je prekinuo vezu.`);
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    });
});

// Pokretanje servera
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server je pokrenut na portu ${PORT}`);
});


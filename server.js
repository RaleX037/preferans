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
        const userExists = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: 'Korisničko ime ili email su već zauzeti.' });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

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
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Neispravno korisničko ime ili lozinka.' });
        }

        const secret = process.env.JWT_SECRET || 'moja_tajna_rec';
        const token = jwt.sign({ username: user.username }, secret, { expiresIn: '24h' });

        res.json({ token, username: user.username });
    } catch (err) {
        console.error('Greška pri prijavi:', err);
        res.status(500).json({ message: 'Greška na serveru pri prijavi.' });
    }
});

// ==========================================
//  ŠPIL I DELJENJE KARATA (Preferans)
// ==========================================
function podeliPreferansKarte() {
    const boje = ['spades', 'diamonds', 'hearts', 'clubs']; // ♠️, ♦️, ♥️, ♣️
    const vrednosti = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let špil = [];

    for (let boja of boje) {
        for (let vrednost of vrednosti) {
            špil.push({ boja: boja, vrednost: vrednost });
        }
    }

    // Mešanje špila (Fisher-Yates)
    for (let i = špil.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [špil[i], špil[j]] = [špil[j], špil[i]];
    }

    // Podela na 3 ruke po 10 karata i talon od 2 karte
    return {
        ruke: [špil.slice(0, 10), špil.slice(10, 20), špil.slice(20, 30)],
        talon: špil.slice(30, 32)
    };
}

// ==========================================
//  SOCKET.IO LOGIKA (Jedan igrač + dva AI bota)
// ==========================================
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

let activeRooms = {}; 

io.on('connection', (socket) => {
    const username = socket.handshake.auth.username || "Igrač";
    console.log(`♣️ Pravi igrač ${username} se povezao na server.`);

    socket.on('join_table', () => {
        const roomId = 'room_' + Date.now(); 
        const karte = podeliPreferansKarte();

        const virtualniIgraci = [
            { id: socket.id, username: username, isBot: false },
            { id: 'bot_left', username: 'Bot_Milan 🤖', isBot: true },
            { id: 'bot_right', username: 'Bot_Zoki 🤖', isBot: true }
        ];

        activeRooms[roomId] = {
            id: roomId,
            players: virtualniIgraci,
            gameState: 'licitation', 
            talon: karte.talon, 
            cards: karte.ruke, 
            currentTurn: 0 
        };

        socket.join(roomId);
        
        // Šaljemo podatke o stolu i isključivo tvoje karte (indeks 0 iz niza ruku)
        socket.emit('game_ready', {
            roomId: roomId,
            allPlayers: virtualniIgraci,
            myCards: karte.ruke[0] 
        });

        console.log(`🚀 Igra sa botovima uspešno pokrenuta u sobi ${roomId} za igrača ${username}!`);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Korisnik ${username} je prekinuo vezu.`);
    });
});

// Pokretanje servera
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server je uspešno pokrenut na portu ${PORT}`);
});


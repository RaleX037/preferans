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
// ==========================================
//  SOCKET.IO LOGIKA SA AI LICITACIJOM
// ==========================================
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
let activeRooms = {}; 

// Pomoćna funkcija: Procena snage botove ruke (broj Aseva i Kraljeva)
function proceniRukuBota(karteBota) {
    let jakeKarte = karteBota.filter(k => k.vrednost === 'A' || k.vrednost === 'K');
    return jakeKarte.length; // Vraća broj jakih karata
}

io.on('connection', (socket) => {
    const username = socket.handshake.auth.username || "Igrač";

    socket.on('join_table', () => {
        const roomId = 'room_' + Date.now(); 
        const karte = podeliPreferansKarte();

        const virtualniIgraci = [
            { id: socket.id, username: username, isBot: false, passed: false },
            { id: 'bot_left', username: 'Bot_Milan 🤖', isBot: true, passed: false },
            { id: 'bot_right', username: 'Bot_Zoki 🤖', isBot: true, passed: false }
        ];

        activeRooms[roomId] = {
            id: roomId,
            players: virtualniIgraci,
            cards: karte.ruke, 
            talon: karte.talon,
            gameState: 'licitation',
            currentTurn: 0, // 0 = Ti, 1 = Bot Levo, 2 = Bot Desno
            trenutnaPonuda: 'Traži se početna reč',
            koJePonudio: 'Niko',
            brojAktivnih: 3
        };

        socket.join(roomId);
        
        socket.emit('game_ready', {
            roomId: roomId,
            allPlayers: virtualniIgraci,
            myCards: karte.ruke[0] // Šaljemo ti tvojih 10 karata
        });

        // Šaljemo početno stanje licitacije (Ti počroku)
        io.to(roomId).emit('licitation_update', {
            players: activeRooms[roomId].players,
            currentTurn: 0,
            trenutnaPonuda: activeRooms[roomId].trenutnaPonuda,
            koJePonudio: activeRooms[roomId].koJePonudio,
            licitacijaZavrsena: false
        });
    });

    // KADA IGRAČ ILI BOT DA KARTU / PONUDU
    socket.on('make_bid', (data) => {
        // Pronalaženje sobe u kojoj se igrač nalazi
        let roomId = Object.keys(activeRooms).find(r => activeRooms[r].players[0].id === socket.id);
        if (!roomId) return;

        let room = activeRooms[roomId];
        let trenutniIgrac = room.players[room.currentTurn];

        // Sigurnosna provera: da li je stvarno red na ovog igrača
        if (trenutniIgrac.id !== socket.id) return;

        izvrsiLicitaciju(room, data.bid, trenutniIgrac.username);
    });
});

// GLAVNA FUNKCIJA ZA MANAGMENT LICITACIJE I BOT POTEZE
function izvrsiLicitaciju(room, izbor, imeIgraca) {
    let trenutniIgrac = room.players[room.currentTurn];

    if (izbor === 'Dalje') {
        trenutniIgrac.passed = true;
        room.brojAktivnih--;
    } else {
        // Ako je ponuda validna (npr. '2', '3', 'Igra')
        room.trenutnaPonuda = izbor;
        room.koJePonudio = imeIgraca;
    }

    // Provera da li je ostao samo jedan igrač koji nije rekao "Dalje"
    if (room.brojAktivnih <= 1) {
        let pobednik = room.players.find(p => !p.passed) || room.players[0];
        
        io.to(room.id).emit('licitation_update', {
            players: room.players,
            licitacijaZavrsena: true,
            pobednikLicitacije: pobednik.username,
            konacnaPonuda: room.trenutnaPonuda,
            poslednjiPotez: { ko: imeIgraca, izbor: izbor }
        });
        return;
    }

    // Pomeri red na sledećeg igrača koji NIJE rekao "Dalje"
    do {
        room.currentTurn = (room.currentTurn + 1) % 3;
    } while (room.players[room.currentTurn].passed);

    // Obavesti sve o trenutnom stanju pre nego što bot odigra
    io.to(room.id).emit('licitation_update', {
        players: room.players,
        currentTurn: room.currentTurn,
        trenutnaPonuda: room.trenutnaPonuda,
        koJePonudio: room.koJePonudio,
        poslednjiPotez: { ko: imeIgraca, izbor: izbor },
        licitacijaZavrsena: false
    });

    // --- LOGIKA AKO JE SLEDEĆI NA POTEZU BOT ---
    let sledeciIgrac = room.players[room.currentTurn];
    if (sledeciIgrac.isBot) {
        setTimeout(() => {
            let snagaRuke = proceniRukuBota(room.cards[room.currentTurn]);
            let botIzbor = 'Dalje';

            // Ako bot ima dobre karte i niko još nije ponudio ništa visoko
            if (snagaRuke >= 3 && room.trenutnaPonuda === 'Traži se početna reč') {
                botIzbor = '2'; // Bot otvara sa "2"
            } else if (snagaRuke >= 5 && room.trenutnaPonuda === '2') {
                botIzbor = '3'; // Bot prati i diže na "3"
            }

            // Bot izvršava svoj potez rekurzivno kroz istu funkciju
            izvrsiLicitaciju(room, botIzbor, sledeciIgrac.username);
        }, 1500); // Mala pauza od 1.5 sekunde da izgleda realistično kao da bot razmišlja!
    }
}

});

// Pokretanje servera
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server je uspešno pokrenut na portu ${PORT}`);
});


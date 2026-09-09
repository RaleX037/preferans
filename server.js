const express = require(const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jwt-simple'); // ili 'jsonwebtoken' u zavisnosti šta koristiš
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

// ==========================================
//  RUTE ZA AUTENTIFIKACIJU (OVO JE FALILO!)
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

        // Hesiranje lozinke radi bezbednosti
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Upis u bazu
        await pool.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
            [username, email, hashedPassword]
        );

        res.status(201).json({ message: 'Uspešna registracija!' });
    } catch (err) {
        console.error(err);
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
        const token = jwt.encode({ userId: user.id, username: user.username }, secret);

        res.json({ token, username: user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Greška na serveru pri prijavi.' });
    }
});

// ==========================================
//  SOCKET.IO LOGIKA (Sobe i igrači)
// ==========================================
const io = new Server(server, {
    cors: {
        origin: "*", // Dozvoljava svim frontend aplikacijama da se povežu
        methods: ["GET", "POST"]
    }
});

// ... (Ovde ide onaj Socket.io kod sa join_table koji smo napisali u prethodnom koraku) ...

// Pokretanje servera
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server je pokrenut na portu ${PORT}`);
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


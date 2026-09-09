-- SQL Šema za PostgreSQL bazu podataka
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE games (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20) DEFAULT 'waiting', -- waiting, active, finished
    current_dealer INT,
    current_turn INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE game_players (
    game_id INT REFERENCES games(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    seat_number INT, -- 1, 2, ili 3 za preferans
    PRIMARY KEY (game_id, user_id)
);

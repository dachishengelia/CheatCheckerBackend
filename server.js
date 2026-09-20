require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const connectDB = require('./db');
const Player = require('./modules/player');

const app = express();
const port = Number(process.env.PORT || 3000);
const steamApiKey = process.env.STEAM_API_KEY;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

let databaseConnection;

app.use(cors({ origin: frontendUrl }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

function getProfileIdentifier(profileUrl) {
    let url;

    try {
        url = new URL(profileUrl.trim());
    } catch {
        throw new Error('Invalid Steam profile URL');
    }

    if (!['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname)) {
        throw new Error('URL must belong to steamcommunity.com');
    }

    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length !== 2 || !['profiles', 'id'].includes(parts[0])) {
        throw new Error('Use /profiles/<steamid64> or /id/<vanity>');
    }

    return { type: parts[0], value: decodeURIComponent(parts[1]) };
}

async function steamRequest(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!response.ok) {
        throw new Error(`Steam API returned HTTP ${response.status}`);
    }

    return response.json();
}

async function getSteamIdFromUrl(profileUrl) {
    const identifier = getProfileIdentifier(profileUrl);

    if (identifier.type === 'profiles') {
        if (!/^\d{17}$/.test(identifier.value)) {
            throw new Error('Invalid SteamID64');
        }
        return identifier.value;
    }

    if (!steamApiKey) {
        throw new Error('STEAM_API_KEY is required');
    }

    const url = new URL('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/');
    url.searchParams.set('key', steamApiKey);
    url.searchParams.set('vanityurl', identifier.value);

    const data = await steamRequest(url);

    if (data?.response?.success !== 1 || !data.response.steamid) {
        throw new Error('Steam vanity URL could not be resolved');
    }

    return data.response.steamid;
}

async function fetchSteamBans(steamId) {
    if (!steamApiKey) {
        throw new Error('STEAM_API_KEY is required');
    }

    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/');
    url.searchParams.set('key', steamApiKey);
    url.searchParams.set('steamids', steamId);

    const data = await steamRequest(url);
    return data?.players?.[0] || null;
}

function normaliseStats(stats) {
    if (!stats || typeof stats !== 'object') return null;

    const values = {
        reactionTime: Number(stats.reactionTime),
        kdRatio: Number(stats.kdRatio),
        wallbangKillPercent: Number(stats.wallbangKillPercent)
    };

    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error('Stats must contain valid non-negative numbers');
    }

    return values;
}

function calculateCheatProbability(stats) {
    if (!stats) return 'unknown';
    if (stats.reactionTime < 150 || stats.wallbangKillPercent > 5 || stats.kdRatio > 1.8) return 'high';
    if (stats.reactionTime < 180 || stats.wallbangKillPercent > 3) return 'medium';
    return 'low';
}

app.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok' });
});

app.use('/players', async (req, res, next) => {
    try {
        databaseConnection ??= connectDB();
        await databaseConnection;
        next();
    } catch (error) {
        databaseConnection = undefined;
        next(error);
    }
});

app.get('/players', async (req, res, next) => {
    try {
        const players = await Player.find().sort({ createdAt: -1 }).lean();
        res.json({ success: true, count: players.length, data: players });
    } catch (error) {
        next(error);
    }
});

app.post('/players', async (req, res, next) => {
    try {
        const { profileUrl, stats } = req.body;

        if (typeof profileUrl !== 'string' || !profileUrl.trim()) {
            return res.status(400).json({ success: false, error: 'profileUrl is required' });
        }

        const identifier = getProfileIdentifier(profileUrl);
        const steamId = await getSteamIdFromUrl(profileUrl);
        const steamBans = await fetchSteamBans(steamId);
        const parsedStats = normaliseStats(stats);

        const player = await Player.create({
            id: crypto.randomUUID(),
            username: identifier.value,
            profileUrl: profileUrl.trim().replace(/\/+$/, ''),
            steamId,
            stats: parsedStats,
            cheatProbability: calculateCheatProbability(parsedStats),
            steamBans
        });

        res.status(201).json({ success: true, data: player });
    } catch (error) {
        next(error);
    }
});

app.delete('/players/:id', async (req, res, next) => {
    try {
        const player = await Player.findOneAndDelete({ id: req.params.id });

        if (!player) {
            return res.status(404).json({ success: false, error: 'Player not found' });
        }

        res.json({ success: true, data: player });
    } catch (error) {
        next(error);
    }
});

app.use((error, req, res, next) => {
    console.error(error.message);
    const clientError = /URL|Steam|stats|SteamID/.test(error.message);
    res.status(clientError ? 400 : 500).json({
        success: false,
        error: error.message || 'Internal server error'
    });
});

async function start() {
    await connectDB();
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

if (require.main === module) {
    start().catch((error) => {
        console.error('Startup failed:', error.message);
        process.exit(1);
    });
}

module.exports = app;

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./db');
const Player = require('./modules/player');

const app = express();
const port = Number(process.env.PORT || 3000);
const steamApiKey = process.env.STEAM_API_KEY;
const frontendUrls = (process.env.FRONTEND_VERCEL_URL || 'http://localhost:5173')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

let databaseConnection;

app.use(cors({
    origin(origin, callback) {
        if (!origin || frontendUrls.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error('Origin is not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    const bans = data?.players?.[0];
    return { vacBanned: Boolean(bans?.VACBanned) };
}

async function fetchSteamProfile(steamId) {
    if (!steamApiKey) {
        throw new Error('STEAM_API_KEY is required');
    }

    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', steamApiKey);
    url.searchParams.set('steamids', steamId);

    const data = await steamRequest(url);
    return data?.response?.players?.[0] || null;
}

function normaliseStats(stats) {
    if (!stats || typeof stats !== 'object') return null;
    if (Object.keys(stats).length === 0) return {};

    const values = {
        totalKills: stats.totalKills === undefined ? undefined : Number(stats.totalKills),
        totalDeaths: stats.totalDeaths === undefined ? undefined : Number(stats.totalDeaths),
        headshotPercent: stats.headshotPercent === undefined ? undefined : Number(stats.headshotPercent),
        winRate: stats.winRate === undefined ? undefined : Number(stats.winRate),
        damagePerRound: stats.damagePerRound === undefined ? undefined : Number(stats.damagePerRound),
        accuracy: stats.accuracy === undefined ? undefined : Number(stats.accuracy),
        mvpCount: stats.mvpCount === undefined ? undefined : Number(stats.mvpCount),
        roundsPlayed: stats.roundsPlayed === undefined ? undefined : Number(stats.roundsPlayed),
        favoriteWeapon: stats.favoriteWeapon
    };

    const numericValues = Object.entries(values)
        .filter(([key, value]) => key !== 'favoriteWeapon' && value !== undefined)
        .map(([, value]) => value);

    if (numericValues.some((value) => !Number.isFinite(value) || value < 0)
        || (values.favoriteWeapon !== undefined && typeof values.favoriteWeapon !== 'string')) {
        throw new Error('Stats must contain valid non-negative numbers');
    }

    return values;
}

function calculateCheatProbability(stats) {
    if (!stats || !Number.isFinite(stats.headshotPercent) || !Number.isFinite(stats.accuracy)) return null;

    const headshotScore = Math.min(stats.headshotPercent / 100, 1);
    const accuracyScore = Math.min(stats.accuracy / 100, 1);
    return Math.round((headshotScore * 0.5 + accuracyScore * 0.5) * 100);
}

function serializePlayer(player) {
    const data = player.toObject ? player.toObject() : player;
    return {
        ...data,
        id: data._id.toString(),
        reports: (data.reports || []).map(({ type, createdAt }) => ({ type, createdAt }))
    };
}

app.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
        res.json({ success: true, data: players.map(serializePlayer) });
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

        const steamId = await getSteamIdFromUrl(profileUrl);
        const profile = await fetchSteamProfile(steamId);
        const steamBans = await fetchSteamBans(steamId);
        const parsedStats = normaliseStats(stats);

        const player = await Player.create({
            username: profile?.personaname || steamId,
            profileUrl: profileUrl.trim().replace(/\/+$/, ''),
            steamId,
            stats: parsedStats || {},
            cheatProbability: calculateCheatProbability(parsedStats),
            steamBans,
            reputation: { positive: 0, negative: 0 },
            reports: []
        });

        res.status(201).json({ success: true, data: serializePlayer(player) });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ success: false, error: 'Player is already tracked' });
        }
        next(error);
    }
});

app.post('/players/:playerId/reputation', async (req, res, next) => {
    try {
        const { vote, reason, voterId } = req.body;
        const allowedReasons = ['Wallhack', 'Aim assist', 'Farmer bot', 'Other cheating'];

        if (!['positive', 'negative'].includes(vote)) {
            return res.status(400).json({ success: false, error: 'vote must be positive or negative' });
        }
        if (typeof voterId !== 'string' || !voterId.trim()) {
            return res.status(400).json({ success: false, error: 'voterId is required' });
        }
        if (vote === 'negative' && !allowedReasons.includes(reason)) {
            return res.status(400).json({ success: false, error: 'A valid report reason is required' });
        }

        const player = await Player.findByIdAndUpdate(
            {
                _id: req.params.playerId,
                'reports.voterId': { $ne: voterId.trim() }
            },
            {
                $inc: { [`reputation.${vote}`]: 1 },
                $push: {
                    reports: {
                        type: vote === 'positive' ? 'Positive reputation' : reason,
                        voterId: voterId.trim(),
                        createdAt: new Date()
                    }
                }
            },
            { new: true }
        );
        if (!player) {
            const existingPlayer = await Player.exists({ _id: req.params.playerId });
            return res.status(existingPlayer ? 409 : 404).json({
                success: false,
                error: existingPlayer ? 'You have already voted for this player' : 'Player not found'
            });
        }

        res.json({ success: true, data: player.reputation });
    } catch (error) {
        next(error);
    }
});

app.delete('/players/:id', async (req, res, next) => {
    try {
        const player = await Player.findByIdAndDelete(req.params.id);

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

const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    username: { type: String, required: true },
    profileUrl: { type: String, required: true },
    stats: {
        totalKills: Number,
        totalDeaths: Number,
        headshotPercent: Number,
        winRate: Number,
        damagePerRound: Number,
        accuracy: Number,
        mvpCount: Number,
        roundsPlayed: Number,
        favoriteWeapon: String
    },
    cheatProbability: { type: Number, min: 0, max: 100, default: null },
    steamId: { type: String, required: true, index: true },
    steamBans: {
        vacBanned: { type: Boolean, default: false }
    },
    reputation: {
        positive: { type: Number, default: 0 },
        negative: { type: Number, default: 0 }
    },
    reports: [{
        type: { type: String, required: true },
        voterId: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

playerSchema.index({ profileUrl: 1 });

module.exports = mongoose.model('Player', playerSchema);

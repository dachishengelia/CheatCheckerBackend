const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    profileUrl: { type: String, required: true },
    stats: {
        reactionTime: Number,
        kdRatio: Number,
        wallbangKillPercent: Number
    },
    cheatProbability: {
        type: String,
        enum: ['unknown', 'low', 'medium', 'high'],
        required: true
    },
    steamId: { type: String, required: true, index: true },
    steamBans: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Player', playerSchema);

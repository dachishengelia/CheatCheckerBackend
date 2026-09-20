const inputUrl = document.getElementById('input-url');
const checkBtn = document.getElementById('check-btn');
const statsCards = document.getElementById('stats-cards');
const submitButton = document.getElementById('check-btn');

async function fetchPlayers() {
    try {
        const response = await fetch('/players');
        const result = await response.json();

        if (result.success === true) {
            return renderPlayers(result.data);
        }
    } catch (err) {
        console.error("failed to fetch", err);
    }
}

function renderPlayers(players) {
    statsCards.innerHTML = '';
    
    if (players.length === 0) {
        statsCards.innerHTML = '<p>No players tracked yet.</p>';
        return;
    }

    players.forEach(player => {
        const card = document.createElement('div');
        card.classList.add('player-card');

        card.innerHTML = `
            <h3>${player.username}</h3>
            <p>Profile: <a href="${player.profileUrl}" target="_blank">View Steam</a></p>
            <p>Cheat Probability: ${player.cheatProbability}</p>
        `;

        statsCards.appendChild(card);
    });
}

submitButton.addEventListener('click', async () => {
    const profileUrl = inputUrl.value.trim();

    if(!profileUrl) return;

    try{
        const response = await fetch('/players', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body:JSON.stringify({ profileUrl })
            }); 

            const result = await response.json();
            if(result.success) {
                inputUrl.value = '';
                fetchPlayers();
            }
    }catch (err){
        console.error("failed to submitButton:", err);
    }
});

fetchPlayers();
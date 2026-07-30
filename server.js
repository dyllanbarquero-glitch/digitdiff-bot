const express = require('express');
const path = require('path');
const app = express();

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 DIGITDIFF BOT - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('🤖 DIGITDIFF BOT ejecutándose en puerto ' + PORT);
});

console.log('🤖 DIGITDIFF BOT - 24/7 ACTIVO');

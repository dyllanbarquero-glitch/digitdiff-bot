const express = require('express');
const path = require('path');
const app = express();

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal - SIRVE EL BOT
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Ruta para UptimeRobot (MANTENER ACTIVO)
app.get('/ping', (req, res) => {
    res.status(200).send('🤖 DIGITDIFF BOT - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('🤖 DIGITDIFF BOT ejecutándose en puerto ' + PORT);
    console.log('🔗 https://digitdiff-bot-production.up.railway.app');
});

console.log('🤖 DIGITDIFF BOT - 24/7 ACTIVO');
console.log('⏰ Auto-conexión activada');
console.log('🔄 Manteniéndose activo automáticamente');

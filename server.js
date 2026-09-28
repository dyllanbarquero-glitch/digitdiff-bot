const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🤖 EVEN BOT (CON MARTINGALA) - BACKEND 24/7');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const SYMBOL = 'R_100';
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb';

// ==================== PARÁMETROS DEL XML ====================
const WIN_AMOUNT = 1.00;            // Win Amount (Stake inicial)
const EXPECTED_PROFIT = 60.00;     // Objective / Take Profit ($10)
const MAX_ACCEPTABLE_LOSS = 10.00; // Stop Loss / Máxima Pérdida Aceptable ($10)
const ODD_STREAK_TRIGGER = 8;      // Disparador: 8 impares seguidos para comprar EVEN
const MARTINGALE_FACTOR = 2;       // Multiplicador de Martingala (Equivalente al bloque XML)

const MAX_RECONNECT = 20000;
const RECONNECT_DELAY = 5000;

// ==================== ESTADO GLOBAL ====================
let ws = null;
let botRunning = false;
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectInterval = null;
let currentAccountId = '';
let currentAccountType = 'demo';
let tradeLogs = [];

let currentStake = WIN_AMOUNT;    // Variable Initial Amount que cambia con la Martingala
let consecutiveOdds = 0;         // Variable consecutive_odds
let pendingTrade = false;
let activeContractId = null;

let botStats = { 
    balance: 0, 
    totalProfit: 0, 
    winCount: 0, 
    lossCount: 0, 
    totalTrades: 0 
};

// ==================== LOGS ====================
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 200) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// ==================== TRADING LOGIC ====================
function executeEvenTrade() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog(`⚠️ WebSocket no disponible para enviar la orden`, 'warning');
        return;
    }
    
    if (pendingTrade || activeContractId !== null) return;
    
    pendingTrade = true;
    addLog(`🎯 Racha de ${ODD_STREAK_TRIGGER} Impares alcanzada. Comprando DIGITEVEN | Stake: $${currentStake.toFixed(2)}`, 'warning');
    
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    
    const proposal = {
        proposal: 1,
        amount: currentStake,
        basis: 'stake',
        contract_type: 'DIGITEVEN',
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: SYMBOL,
        passthrough: { reqId: reqId }
    };
    
    ws.send(JSON.stringify(proposal));
}

function checkRiskManagement() {
    // Verificar Target Profit (Ganancia Esperada)
    if (botStats.totalProfit >= EXPECTED_PROFIT) {
        addLog(`🎉 ¡OBJETIVO DE GANANCIA ALCANZADO! Total Profit: +$${botStats.totalProfit.toFixed(2)}`, 'win');
        botRunning = false;
        return true;
    }

    // Verificar Stop Loss (Máxima Pérdida Aceptable)
    if (botStats.totalProfit < 0 && Math.abs(botStats.totalProfit) >= MAX_ACCEPTABLE_LOSS) {
        addLog(`🛑 LÍMITE DE PÉRDIDA ALCANZADO (Stop Loss). Total Profit: -$${Math.abs(botStats.totalProfit).toFixed(2)}`, 'loss');
        botRunning = false;
        return true;
    }

    return false;
}

function processResult(contractId, profit, exitTick) {
    const lastDigit = exitTick ? getLastDigit(exitTick) : '?';
    const isEven = lastDigit !== '?' ? (lastDigit % 2 === 0) : false;

    botStats.totalTrades++;
    botStats.totalProfit += profit;
    botStats.balance += profit;
    
    // LÓGICA DE MARTINGALA IGUAL AL BLOQUE AFTER_PURCHASE DEL XML
    if (profit > 0) {
        botStats.winCount++;
        addLog(`✅ GANADA | Salió ${lastDigit} (${isEven ? 'PAR' : 'IMPAR'}) | +$${profit.toFixed(2)} | Profit: $${botStats.totalProfit.toFixed(2)}`, 'win');
        
        // Al ganar, resetear Stake al valor inicial (Win Amount)
        currentStake = WIN_AMOUNT;
        addLog(`🔄 Stake reseteado a $${currentStake.toFixed(2)}`, 'info');
    } else {
        botStats.lossCount++;
        addLog(`❌ PERDIDA | Salió ${lastDigit} (${isEven ? 'PAR' : 'IMPAR'}) | -$${Math.abs(profit).toFixed(2)} | Profit: $${botStats.totalProfit.toFixed(2)}`, 'loss');
        
        // Al perder, aplicar Martingala (Aumenta el Stake)
        currentStake = currentStake * MARTINGALE_FACTOR;
        addLog(`📈 Aplicando Martingala: Nuevo Stake = $${currentStake.toFixed(2)}`, 'warning');
    }
    
    activeContractId = null;
    pendingTrade = false;

    // Evaluación de Take Profit y Stop Loss
    const stopBot = checkRiskManagement();
    if (!stopBot && botRunning) {
        addLog(`⏳ Esperando siguiente racha de ${ODD_STREAK_TRIGGER} impares...`, 'info');
    }
}

function processTick(price) {
    const digit = getLastDigit(price);
    if (digit === null) return;
    
    const isOdd = (digit % 2 !== 0);

    // Lógica del bloque tick_analysis del XML
    if (isOdd) {
        consecutiveOdds++;
        addLog(`📊 Tick: ${price} → Último Dígito: ${digit} (IMPAR) | Racha: ${consecutiveOdds}/${ODD_STREAK_TRIGGER}`, 'info');
    } else {
        consecutiveOdds = 0; // Reinicio al salir PAR
    }

    // Lógica del bloque before_purchase del XML
    if (botRunning && consecutiveOdds >= ODD_STREAK_TRIGGER) {
        if (!pendingTrade && activeContractId === null) {
            consecutiveOdds = 0; // Reset streak tras activar compra
            executeEvenTrade();
        }
    }
}

function getLastDigit(price) {
    try { 
        const num = parseFloat(price);
        if (isNaN(num)) return null;
        return parseInt(num.toFixed(2).slice(-1)); 
    } catch { 
        return null; 
    }
}

// ==================== WEBSOCKET HANDLER ====================
function handleMsg(data) {
    if (data.error) { 
        addLog(`❌ Error API: ${data.error.message || JSON.stringify(data.error)}`, 'loss'); 
        pendingTrade = false;
        return; 
    }
    
    if (data.msg_type === 'balance' || data.balance) {
        const bal = data.balance?.balance || data.balance;
        if (bal && typeof bal === 'number') { 
            botStats.balance = parseFloat(bal); 
        }
        return;
    }
    
    if (data.tick) { 
        if (data.tick.symbol === SYMBOL) {
            processTick(data.tick.quote); 
        }
    }
    
    if (data.proposal && botRunning) { 
        ws.send(JSON.stringify({ 
            buy: data.proposal.id, 
            price: data.proposal.ask_price 
        }));
    }
    
    if (data.buy) {
        activeContractId = data.buy.contract_id;
        pendingTrade = false;
        
        addLog(`📝 Contrato DIGITEVEN N° ${activeContractId} comprado exitosamente`, 'info');

        ws.send(JSON.stringify({ 
            proposal_open_contract: 1, 
            contract_id: activeContractId,
            subscribe: 1 
        }));
    }
    
    if (data.proposal_open_contract?.is_sold) {
        const c = data.proposal_open_contract;
        const profit = parseFloat(c.profit || 0);
        const cid = c.contract_id;
        const exitTick = c.exit_tick_display_value;

        if (cid === activeContractId) { 
            processResult(cid, profit, exitTick); 
        }

        if (c.subscription?.id) {
            ws.send(JSON.stringify({ forget: c.subscription.id }));
        }
    }
}

function openWS(url) {
    if (ws) try { ws.close(); } catch (e) {}
    ws = new WebSocket(url);

    ws.onopen = () => {
        addLog('✅ WebSocket conectado exitosamente', 'win');
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
        addLog(`📊 Monitoreando ticks en vivo para ${SYMBOL}`, 'win');
        
        if (!botRunning) {
            botRunning = true;
            addLog(`🚀 BOT INICIADO AUTOMÁTICAMENTE`, 'win');
            addLog(`⚙️ Configuración: Stake Inicial = $${WIN_AMOUNT} | Trigger = ${ODD_STREAK_TRIGGER} Impares | Target Profit = $${EXPECTED_PROFIT} | Stop Loss = $${MAX_ACCEPTABLE_LOSS} | Martingala = x${MARTINGALE_FACTOR}`, 'info');
        }
    };
    
    ws.onmessage = (e) => { try { handleMsg(JSON.parse(e.data)); } catch (err) {} };
    ws.onerror = () => { addLog('❌ Error en WebSocket', 'loss'); };
    ws.onclose = () => {
        addLog('🔌 Conexión cerrada', 'loss');
        if (botRunning) scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    addLog('🔄 Intentando reconexión...', 'warning');
    reconnectAttempts = 0;
    if (reconnectInterval) clearInterval(reconnectInterval);
    reconnectInterval = setInterval(async () => {
        if (reconnectAttempts >= MAX_RECONNECT) { 
            addLog('❌ Límite de reconexiones alcanzado', 'loss'); 
            clearInterval(reconnectInterval); 
            reconnecting = false; 
            return; 
        }
        reconnectAttempts++;
        try {
            const headers = { 
                'Deriv-App-ID': APP_ID, 
                'Authorization': `Bearer ${PAT_TOKEN}`, 
                'Content-Type': 'application/json' 
            };
            const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${currentAccountId}/otp`, { 
                method: 'POST', 
                headers 
            });
            if (otpResp.ok) { 
                const d = await otpResp.json(); 
                if (d.data?.url) { 
                    openWS(d.data.url); 
                    reconnectAttempts = 0; 
                    reconnecting = false;
                    clearInterval(reconnectInterval);
                    return; 
                } 
            }
        } catch (e) {}
    }, RECONNECT_DELAY);
}

async function connectDeriv() {
    addLog('🔗 Conectando a Deriv...', 'info');
    try {
        const headers = { 
            'Deriv-App-ID': APP_ID, 
            'Authorization': `Bearer ${PAT_TOKEN}`, 
            'Content-Type': 'application/json' 
        };
        const accResp = await fetch(`${REST_BASE}/trading/v1/options/accounts`, { headers });
        if (!accResp.ok) throw new Error(`Error ${accResp.status}`);
        const accData = await accResp.json();
        const accounts = accData.data || [];
        if (!accounts.length) throw new Error('No se encontraron cuentas');
        
        const account = accounts.find(a => a.account_type === 'demo' || a.account_id.startsWith('VRTC')) || accounts[0];
        currentAccountId = account.account_id;
        currentAccountType = account.account_type;
        botStats.balance = parseFloat(account.balance || 0);
        addLog(`✅ Cuenta Autenticada: ${account.account_id} (${currentAccountType.toUpperCase()})`, 'win');
        
        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { 
            method: 'POST', 
            headers 
        });
        if (!otpResp.ok) throw new Error(`Error OTP: ${otpResp.status}`);
        const otpData = await otpResp.json();
        if (!otpData.data?.url) throw new Error('No se pudo obtener URL de WebSocket');
        openWS(otpData.data.url);
    } catch (e) {
        addLog(`❌ Error de conexión inicial: ${e.message}`, 'loss');
        setTimeout(connectDeriv, 5000);
    }
}

// ==================== SERVIDOR WEB ====================
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/api/stats', (req, res) => {
    res.json({
        balance: botStats.balance,
        totalProfit: botStats.totalProfit,
        winCount: botStats.winCount,
        lossCount: botStats.lossCount,
        totalTrades: botStats.totalTrades,
        currentStake: currentStake,
        consecutiveOdds: consecutiveOdds,
        botRunning: botRunning,
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 EVEN BOT ACTIVO - ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor iniciado en puerto ${PORT}`);
    console.log(`🔗 App URL: https://digitdiff-bot-production.up.railway.app`);
});

// ==================== INICIO ====================
connectDeriv();

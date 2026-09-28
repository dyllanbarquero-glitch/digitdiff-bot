const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🤖 DIGITDIFF BOT - BACKEND 24/7');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const SYMBOL = 'R_100';
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb';

// ==================== GESTIÓN DE RIESGO Y ESTRATEGIA ====================
const WIN_AMOUNT = 1.00;            // Stake Inicial ($1)
const EXPECTED_PROFIT = 300.00;     // Target Profit ($10)
const MAX_ACCEPTABLE_LOSS = 10.00; // Stop Loss ($10)
const TRIGGER = 5;                 // Dígitos iguales seguidos para disparar la orden
const MARTINGALE_FACTOR = 11;      // Multiplicador Martingala para DIGITDIFF (por ratio de pago)

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

let currentStake = WIN_AMOUNT;
let lastDigit = null;
let consecutiveCount = 0;
let pendingTrade = false;
let activeContractId = null;
let targetBarrier = null;

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
function executeDiffTrade(digit) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog(`⚠️ WebSocket no disponible`, 'warning');
        return;
    }
    
    if (pendingTrade || activeContractId !== null) return;
    
    pendingTrade = true;
    targetBarrier = digit;
    addLog(`🎯 Dígito ${digit} x${TRIGGER} consecutivas. Comprando DIGITDIFF ≠ ${digit} | Stake: $${currentStake.toFixed(2)}`, 'warning');
    
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    
    const proposal = {
        proposal: 1,
        amount: currentStake,
        basis: 'stake',
        contract_type: 'DIGITDIFF',
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: SYMBOL,
        barrier: digit.toString(),
        passthrough: { reqId: reqId }
    };
    
    ws.send(JSON.stringify(proposal));
}

function checkRiskManagement() {
    if (botStats.totalProfit >= EXPECTED_PROFIT) {
        addLog(`🎉 ¡OBJETIVO DE GANANCIA ALCANZADO! Profit Total: +$${botStats.totalProfit.toFixed(2)}`, 'win');
        botRunning = false;
        return true;
    }

    if (botStats.totalProfit < 0 && Math.abs(botStats.totalProfit) >= MAX_ACCEPTABLE_LOSS) {
        addLog(`🛑 LÍMITE DE PÉRDIDA ALCANZADO (Stop Loss). Profit Total: -$${Math.abs(botStats.totalProfit).toFixed(2)}`, 'loss');
        botRunning = false;
        return true;
    }

    return false;
}

function processResult(contractId, profit, exitTick) {
    const resultDigit = exitTick ? getLastDigit(exitTick) : '?';

    botStats.totalTrades++;
    botStats.totalProfit += profit;
    botStats.balance += profit;
    
    if (profit > 0) {
        botStats.winCount++;
        addLog(`✅ GANADA | Salió ${resultDigit} (Diferente a ${targetBarrier}) | +$${profit.toFixed(2)} | Total Profit: $${botStats.totalProfit.toFixed(2)}`, 'win');
        currentStake = WIN_AMOUNT; // Reset Stake
    } else {
        botStats.lossCount++;
        addLog(`❌ PERDIDA | Salió ${resultDigit} (Igual a ${targetBarrier}) | -$${Math.abs(profit).toFixed(2)} | Total Profit: $${botStats.totalProfit.toFixed(2)}`, 'loss');
        currentStake = currentStake * MARTINGALE_FACTOR; // Aplicar Martingala
        addLog(`📈 Aplicando Martingala: Nuevo Stake = $${currentStake.toFixed(2)}`, 'warning');
    }
    
    activeContractId = null;
    pendingTrade = false;
    targetBarrier = null;

    const stopBot = checkRiskManagement();
    if (!stopBot && botRunning) {
        addLog(`⏳ Esperando nuevo patrón de repetición...`, 'info');
    }
}

function processTick(price) {
    const digit = getLastDigit(price);
    if (digit === null) return;

    if (digit === lastDigit) {
        consecutiveCount++;
    } else {
        consecutiveCount = 1;
        lastDigit = digit;
    }

    addLog(`📊 Tick: ${price} → Dígito: ${digit} | Consecutivos: x${consecutiveCount}`, 'info');

    if (botRunning && consecutiveCount >= TRIGGER) {
        if (!pendingTrade && activeContractId === null) {
            const digitToTrade = lastDigit;
            consecutiveCount = 0; // Reiniciar racha
            executeDiffTrade(digitToTrade);
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
        
        addLog(`📝 Orden DIGITDIFF activada N° ${activeContractId}`, 'info');

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
        addLog('✅ WebSocket Conectado', 'win');
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
        addLog(`📊 Monitoreando ticks en vivo para ${SYMBOL}`, 'win');
        
        if (!botRunning) {
            botRunning = true;
            addLog(`🚀 BOT DIGITDIFF INICIADO`, 'win');
            addLog(`⚙️ Parámetros: Stake = $${WIN_AMOUNT} | Trigger = ${TRIGGER} repeticiones | Target Profit = $${EXPECTED_PROFIT} | Stop Loss = $${MAX_ACCEPTABLE_LOSS}`, 'info');
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
    addLog('🔄 Reconectando...', 'warning');
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
    addLog('🔗 Autenticando en Deriv...', 'info');
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
        if (!accounts.length) throw new Error('Sin cuentas disponibles');
        
        const account = accounts.find(a => a.account_type === 'demo' || a.account_id.startsWith('VRTC')) || accounts[0];
        currentAccountId = account.account_id;
        currentAccountType = account.account_type;
        botStats.balance = parseFloat(account.balance || 0);
        addLog(`✅ Cuenta Vinculada: ${account.account_id} (${currentAccountType.toUpperCase()})`, 'win');
        
        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { 
            method: 'POST', 
            headers 
        });
        if (!otpResp.ok) throw new Error(`Error OTP: ${otpResp.status}`);
        const otpData = await otpResp.json();
        if (!otpData.data?.url) throw new Error('Sin URL WebSocket');
        openWS(otpData.data.url);
    } catch (e) {
        addLog(`❌ Error Conexión: ${e.message}`, 'loss');
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
        lastDigit: lastDigit,
        consecutiveCount: consecutiveCount,
        botRunning: botRunning,
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 DIGITDIFF BOT ACTIVO - ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});

// ==================== INICIO ====================
connectDeriv();

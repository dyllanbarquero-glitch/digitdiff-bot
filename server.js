const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🤖 PREDICTOR PROBABILITY BOT - BACKEND 24/7');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const SYMBOL = 'R_100';
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb';

// ==================== PARÁMETROS DEL XML ====================
const WIN_AMOUNT = 1.00;            // Win Amount ($1)
const EXPECTED_PROFIT = 10.00;     // Target Profit ($10)
const MAX_ACCEPTABLE_LOSS = 10.00; // Stop Loss ($10)
const MIN_CONFIDENCE = 0.7;        // 70% de tasa mínima requerida
const MIN_SAMPLES = 25;            // Mínimo de muestras para operar
const MAX_SAMPLES = 50;            // Muestra máxima para resetear conteo

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
let pendingTrade = false;
let activeContractId = null;

// Variables de análisis estadístico del XML
let evenCount = 0;
let oddCount = 0;
let sampleCount = 0;

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
function executeTrade(contractType, confidenceRate) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog(`⚠️ WebSocket no disponible`, 'warning');
        return;
    }
    
    if (pendingTrade || activeContractId !== null) return;
    
    pendingTrade = true;
    addLog(`🎯 Tasa requerida alcanzada (${(confidenceRate * 100).toFixed(1)}%). Comprando ${contractType} | Stake: $${currentStake.toFixed(2)}`, 'warning');
    
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    
    const proposal = {
        proposal: 1,
        amount: currentStake,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: SYMBOL,
        passthrough: { reqId: reqId }
    };
    
    ws.send(JSON.stringify(proposal));
}

function checkRiskManagement() {
    if (botStats.totalProfit >= EXPECTED_PROFIT) {
        addLog(`🎉 ¡Objetivo de Ganancia Alcanzado! Total Profit: +$${botStats.totalProfit.toFixed(2)}`, 'win');
        botRunning = false;
        return true;
    }

    if (botStats.totalProfit < 0 && Math.abs(botStats.totalProfit) >= MAX_ACCEPTABLE_LOSS) {
        addLog(`🛑 Límite de Pérdida Alcanzado. Total Profit: -$${Math.abs(botStats.totalProfit).toFixed(2)}`, 'loss');
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
    
    // LÓGICA AFTER_PURCHASE DEL XML
    if (profit < 0) {
        botStats.lossCount++;
        const lossAmount = Math.abs(profit);
        // Math change Initial Amount by ABS(Profit) * 1
        currentStake += lossAmount * 1;
        addLog(`❌ PERDIDA | Salió ${lastDigit} (${isEven ? 'PAR' : 'IMPAR'}) | -$${lossAmount.toFixed(2)} | Nuevo Stake = $${currentStake.toFixed(2)}`, 'loss');
    } else {
        botStats.winCount++;
        // Reset a Win Amount
        currentStake = WIN_AMOUNT;
        addLog(`✅ GANADA | Salió ${lastDigit} (${isEven ? 'PAR' : 'IMPAR'}) | +$${profit.toFixed(2)} | Stake reseteado a $${currentStake.toFixed(2)}`, 'win');
    }
    
    activeContractId = null;
    pendingTrade = false;

    const stopBot = checkRiskManagement();
    if (!stopBot && botRunning) {
        addLog(`⏳ Esperando siguientes señales estadisticas...`, 'info');
    }
}

function evaluateBeforePurchase() {
    if (!botRunning || pendingTrade || activeContractId !== null) return;

    // Bloque before_purchase: requiere sample_count >= 25
    if (sampleCount >= MIN_SAMPLES) {
        const evenRate = evenCount / sampleCount;
        const oddRate = oddCount / sampleCount;

        // Condición 1: even_rate >= min_confidence AND even_rate >= odd_rate -> Comprar DIGITODD
        if (evenRate >= MIN_CONFIDENCE && evenRate >= oddRate) {
            executeTrade('DIGITODD', evenRate);
            return;
        }

        // Condición 2: odd_rate >= min_confidence AND odd_rate > even_rate -> Comprar DIGITEVEN
        if (oddRate >= MIN_CONFIDENCE && oddRate > evenRate) {
            executeTrade('DIGITEVEN', oddRate);
            return;
        }
    }
}

function processTick(price) {
    const digit = getLastDigit(price);
    if (digit === null) return;

    // Bloque tick_analysis: Incrementar contadores
    if (digit % 2 !== 0) {
        oddCount++;
    } else {
        evenCount++;
    }
    sampleCount++;

    const evenRatePct = ((evenCount / sampleCount) * 100).toFixed(1);
    const oddRatePct = ((oddCount / sampleCount) * 100).toFixed(1);

    addLog(`📊 Tick: ${price} → Dígito: ${digit} | Muestra: ${sampleCount}/${MAX_SAMPLES} | Par: ${evenRatePct}% | Impar: ${oddRatePct}%`, 'info');

    // Evaluar estrategia después de actualizar ticks
    evaluateBeforePurchase();

    // Reset de muestra cuando llega a 50 ticks (según tick_analysis del XML)
    if (sampleCount >= MAX_SAMPLES) {
        addLog(`🔄 Muestra de ${MAX_SAMPLES} ticks completada. Reiniciando contadores de probabilidad.`, 'warning');
        evenCount = 0;
        oddCount = 0;
        sampleCount = 0;
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
        
        addLog(`📝 Orden ejecutada N° ${activeContractId}`, 'info');

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
            addLog(`🚀 BOT PREDICTOR PROBABILITY INICIADO`, 'win');
            addLog(`⚙️ Parámetros: Stake = $${WIN_AMOUNT} | Min Confianza = ${MIN_CONFIDENCE * 100}% | Muestras = ${MIN_SAMPLES}-${MAX_SAMPLES} | Target Profit = $${EXPECTED_PROFIT} | Stop Loss = $${MAX_ACCEPTABLE_LOSS}`, 'info');
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
        evenCount: evenCount,
        oddCount: oddCount,
        sampleCount: sampleCount,
        botRunning: botRunning,
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 PREDICTOR BOT ACTIVO - ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});

// ==================== INICIO ====================
connectDeriv();

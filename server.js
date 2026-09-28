const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🤖 EVEN TRADER BOT - BACKEND 24/7');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const SYMBOLS = ['R_100'];
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb';

// Parámetros de la Estrategia EVEN
const ODD_STREAK_TRIGGER = 8; // Activa compra EVEN cuando ocurren N impares consecutivos
const STAKE = 50.00;
const LOOKBACK = 50;
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
let allAccounts = [];
let currentTradingSymbol = null;
let tradeLogs = [];
let botStats = { balance: 0, totalProfit: 0, winCount: 0, lossCount: 0, totalTrades: 0 };

const symState = {};
SYMBOLS.forEach(s => {
    symState[s] = {
        tickHistory: [], 
        oddStreak: 0, 
        lastDigit: null,
        pending: false, 
        activeContracts: new Map()
    };
});

const contractSymbolMap = new Map();
const pendingProposals = new Map();

// ==================== LOGS ====================
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 200) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// ==================== TRADING LOGIC ====================
function executeTrade(sym) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog(`⚠️ [${sym}] WebSocket no disponible`, 'warning');
        return;
    }
    const st = symState[sym];
    if (!st || st.lastDigit === null) return;
    
    if (st.pending || st.activeContracts.size > 0) return;
    
    st.pending = true;
    currentTradingSymbol = sym;
    
    addLog(`🎯 [${sym}] Racha de ${st.oddStreak} Impares → Comprando EVEN | $${STAKE}`, 'warning');
    
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    pendingProposals.set(reqId, { symbol: sym });

    const proposal = {
        proposal: 1,
        amount: STAKE,
        basis: 'stake',
        contract_type: 'DIGITEVEN', // Tipo de contrato PAR
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: sym,
        passthrough: { reqId: reqId }
    };
    
    ws.send(JSON.stringify(proposal));
}

function processResult(contractId, profit, exitTick, sym) {
    const digit = exitTick ? getLastDigit(exitTick) : '?';
    const isEven = digit !== '?' ? (digit % 2 === 0) : false;

    botStats.totalTrades++;
    botStats.totalProfit += profit;
    botStats.balance += profit;
    
    if (profit > 0) {
        botStats.winCount++;
        addLog(`✅ WIN [${sym}] Salió ${digit} (${isEven ? 'PAR' : 'IMPAR'}) | +$${profit.toFixed(2)}`, 'win');
    } else {
        botStats.lossCount++;
        addLog(`❌ LOSS [${sym}] Salió ${digit} (${isEven ? 'PAR' : 'IMPAR'}) | -$${Math.abs(profit).toFixed(2)}`, 'loss');
    }
    
    if (symState[sym]) {
        symState[sym].activeContracts.delete(contractId);
        symState[sym].pending = false;
    }
    contractSymbolMap.delete(contractId);
}

function processTick(sym, price) {
    const digit = getLastDigit(price);
    if (digit === null) return;
    
    const st = symState[sym];
    if (!st) return;
    
    const isEven = (digit % 2 === 0);

    if (!isEven) {
        st.oddStreak++;
    } else {
        st.oddStreak = 0; // Se reinicia al salir un número PAR
    }

    st.lastDigit = digit;
    st.tickHistory.unshift(digit);
    if (st.tickHistory.length > LOOKBACK) st.tickHistory.pop();
    
    // Disparo de entrada cuando se alcanza la racha de impares establecida
    if (botRunning && st.oddStreak >= ODD_STREAK_TRIGGER) {
        if (st.activeContracts.size === 0 && !st.pending) {
            executeTrade(sym);
            st.oddStreak = 0; // Reinicio tras ejecutar entrada
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
        if (currentTradingSymbol && symState[currentTradingSymbol]) {
            symState[currentTradingSymbol].pending = false;
        }
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
        const { symbol, quote } = data.tick; 
        processTick(symbol, quote); 
    }
    
    if (data.proposal && botRunning) { 
        const reqId = data.echo_req?.passthrough?.reqId;
        const pData = pendingProposals.get(reqId);
        
        if (pData) {
            ws.send(JSON.stringify({ 
                buy: data.proposal.id, 
                price: data.proposal.ask_price,
                passthrough: { reqId: reqId, symbol: pData.symbol }
            }));
        } else {
            ws.send(JSON.stringify({ buy: data.proposal.id, price: data.proposal.ask_price })); 
        }
    }
    
    if (data.buy) {
        const id = data.buy.contract_id;
        const reqId = data.echo_req?.passthrough?.reqId;
        const sym = (reqId && pendingProposals.has(reqId)) ? pendingProposals.get(reqId).symbol : (currentTradingSymbol || 'UNKNOWN');
        
        if (reqId) pendingProposals.delete(reqId);

        if (symState[sym]) { 
            symState[sym].activeContracts.set(id, { id }); 
            symState[sym].pending = false; 
        }
        contractSymbolMap.set(id, sym); 
        currentTradingSymbol = null; 
        
        ws.send(JSON.stringify({ 
            proposal_open_contract: 1, 
            contract_id: id,
            subscribe: 1 
        }));
    }
    
    if (data.proposal_open_contract?.is_sold) {
        const c = data.proposal_open_contract;
        const profit = parseFloat(c.profit || 0);
        const cid = c.contract_id;
        const exitTick = c.exit_tick_display_value;
        const sym = contractSymbolMap.get(cid) || 'UNKNOWN';

        if (symState[sym]?.activeContracts.has(cid)) { 
            processResult(cid, profit, exitTick, sym); 
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
        addLog('✅ WebSocket conectado!', 'win');
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        SYMBOLS.forEach(sym => ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })));
        addLog(`📊 Suscrito a ${SYMBOLS.length} pares`, 'win');
        
        // Auto-iniciar el bot
        if (!botRunning) {
            botRunning = true;
            addLog(`🚀 BOT INICIADO AUTOMÁTICAMENTE | Estrategia: EVEN | Trigger: ${ODD_STREAK_TRIGGER} Impares Seguidos | Stake: $${STAKE}`, 'win');
        }
    };
    
    ws.onmessage = (e) => { try { handleMsg(JSON.parse(e.data)); } catch (err) {} };
    ws.onerror = () => { addLog('❌ Error WebSocket', 'loss'); };
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
            addLog('❌ Máximos intentos de reconexión alcanzados', 'loss'); 
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
        allAccounts = accData.data || [];
        if (!allAccounts.length) throw new Error('No se encontraron cuentas');
        
        const account = allAccounts.find(a => a.account_type === 'demo' || a.account_id.startsWith('VRTC')) || allAccounts[0];
        currentAccountId = account.account_id;
        currentAccountType = account.account_type;
        botStats.balance = parseFloat(account.balance || 0);
        addLog(`✅ Cuenta: ${account.account_id} (${currentAccountType.toUpperCase()})`, 'win');
        
        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { 
            method: 'POST', 
            headers 
        });
        if (!otpResp.ok) throw new Error(`Error OTP: ${otpResp.status}`);
        const otpData = await otpResp.json();
        if (!otpData.data?.url) throw new Error('No se obtuvo URL de suscripción');
        openWS(otpData.data.url);
    } catch (e) {
        addLog(`❌ Error conexión: ${e.message}`, 'loss');
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
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 EVEN TRADER BOT - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web escuchando en el puerto ${PORT}`);
    console.log(`🔗 https://digitdiff-bot-production.up.railway.app`);
});

// ==================== INICIO ====================
console.log('🤖 EVEN TRADER BOT - BACKEND 24/7');
console.log(`📊 ${SYMBOLS.length} pares · Trigger: ${ODD_STREAK_TRIGGER} impares · Stake: $${STAKE}`);
console.log('⏰ El bot funciona automáticamente 24/7');
connectDeriv();

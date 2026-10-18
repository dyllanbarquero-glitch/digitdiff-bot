const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

// ==================== CONFIG ====================
const REST_BASE = 'https://api.derivws.com';
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb'; // ⚠️ REVOCAR YA
const MAX_RECONNECT = 20;
const RECONNECT_DELAY = 5000;

// ==================== ESTRATEGIA DIGITEVEN ====================
// 3 dígitos IMPARES seguidos → comprar DIGITEVEN (par)
// Stake fijo $2.35 · Take Profit $5.00 · Max Loss $5.00
const STRATEGY = {
    id: 'digiteven',
    symbol: 'R_100',
    contractType: 'DIGITEVEN',
    stake: 0.35,
    triggerCount: 7,        // 3 impares seguidos
    takeProfit: 30.00,
    maxLoss: 10.00,
    state: {
        consecutiveOdds: 0,
        lastDigit: null,
        pending: false,
        activeContracts: new Map(),
        totalProfit: 0,
        winCount: 0,
        lossCount: 0,
        totalTrades: 0,
        stopped: false
    }
};

// ==================== ROUTING req_id ====================
let reqIdSeq = 0;
const pendingReqIds = new Set();
const contractIds = new Set();

let ws = null, botRunning = false, reconnecting = false;
let reconnectAttempts = 0, reconnectInterval = null;
let currentAccountId = '', currentAccountType = 'demo';
let tradeLogs = [];
let balance = 0;

// ==================== LOGS ====================
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 200) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// ==================== SEND ====================
function sendToDeriv(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog('⚠️ WS no disponible', 'warning');
        return null;
    }
    const reqId = ++reqIdSeq;
    payload.req_id = reqId;
    pendingReqIds.add(reqId);
    setTimeout(() => pendingReqIds.delete(reqId), 60000);
    ws.send(JSON.stringify(payload));
    return reqId;
}

// ==================== TICKS ====================
function getLastDigit(price) {
    try { return parseInt(parseFloat(price).toFixed(2).slice(-1)); }
    catch { return null; }
}

function processTick(symbol, price) {
    if (symbol !== STRATEGY.symbol) return;
    if (STRATEGY.state.stopped) return;

    const digit = getLastDigit(price);
    if (digit === null) return;

    const st = STRATEGY.state;
    const isOdd = digit % 2 === 1;
    st.consecutiveOdds = isOdd ? st.consecutiveOdds + 1 : 0;
    st.lastDigit = digit;

    if (st.consecutiveOdds >= STRATEGY.triggerCount) {
        if (st.pending || st.activeContracts.size > 0) return;
        st.consecutiveOdds = 0; // reset ANTES de comprar (igual que Blockly)
        executeTrade();
    }
}

// ==================== TRADING ====================
function executeTrade() {
    const st = STRATEGY.state;
    st.pending = true;

    addLog(`🎯 ENTRADA | ${STRATEGY.contractType} | $${STRATEGY.stake} | Racha impares alcanzada`, 'warning');

    sendToDeriv({
        proposal: 1,
        amount: STRATEGY.stake,
        basis: 'stake',
        contract_type: STRATEGY.contractType,
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: STRATEGY.symbol
    });
}

function processResult(contractId, profit) {
    const st = STRATEGY.state;
    st.totalTrades++;
    st.totalProfit += profit;

    if (profit > 0) {
        st.winCount++;
        addLog(`✅ WIN +$${profit.toFixed(2)} | Total: $${st.totalProfit.toFixed(2)}`, 'win');
    } else {
        st.lossCount++;
        addLog(`❌ LOSS -$${Math.abs(profit).toFixed(2)} | Total: $${st.totalProfit.toFixed(2)}`, 'loss');
    }

    st.activeContracts.delete(contractId);
    st.pending = false;
    contractIds.delete(contractId);

    if (st.totalProfit >= STRATEGY.takeProfit) {
        st.stopped = true;
        addLog(`🏆 TAKE PROFIT alcanzado: +$${st.totalProfit.toFixed(2)} — bot detenido`, 'success');
    } else if (st.totalProfit <= -STRATEGY.maxLoss) {
        st.stopped = true;
        addLog(`🛑 MAX LOSS alcanzado: -$${Math.abs(st.totalProfit).toFixed(2)} — bot detenido`, 'loss');
    }
}

// ==================== HANDLER WS ====================
function handleMsg(data) {
    if (data.error) {
        addLog(`❌ Error: ${data.error.message || JSON.stringify(data.error)}`, 'loss');
        STRATEGY.state.pending = false;
        return;
    }

    if (data.msg_type === 'balance' || data.balance) {
        const bal = typeof data.balance === 'object' ? data.balance?.balance : data.balance;
        if (typeof bal === 'number') balance = bal;
        return;
    }

    if (data.tick) { processTick(data.tick.symbol, data.tick.quote); return; }

    if (data.proposal) {
        if (STRATEGY.state.stopped) { STRATEGY.state.pending = false; return; }
        sendToDeriv({ buy: data.proposal.id, price: data.proposal.ask_price });
        return;
    }

    if (data.buy) {
        const id = data.buy.contract_id;
        STRATEGY.state.activeContracts.set(id, { id });
        STRATEGY.state.pending = false;
        contractIds.add(id);

        const monitor = setInterval(() => {
            if (!STRATEGY.state.activeContracts.has(id)) { clearInterval(monitor); return; }
            if (ws?.readyState === WebSocket.OPEN)
                sendToDeriv({ proposal_open_contract: 1, contract_id: id });
        }, 1200);
        setTimeout(() => clearInterval(monitor), 35000);
        return;
    }

    if (data.proposal_open_contract?.is_sold) {
        const c = data.proposal_open_contract;
        if (contractIds.has(c.contract_id))
            processResult(c.contract_id, parseFloat(c.profit || 0));
        return;
    }
}

// ==================== WEBSOCKET ====================
function openWS(url) {
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(url);

    ws.onopen = () => {
        addLog('✅ WebSocket conectado!', 'success');
        reconnectAttempts = 0;
        reconnecting = false;

        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        ws.send(JSON.stringify({ ticks: STRATEGY.symbol, subscribe: 1 }));
        addLog(`📊 Suscrito a ${STRATEGY.symbol}`, 'success');

        if (!botRunning) {
            botRunning = true;
            addLog(`🚀 BOT INICIADO | ${STRATEGY.contractType} · $${STRATEGY.stake} · TP $${STRATEGY.takeProfit} / SL $${STRATEGY.maxLoss}`, 'success');
        }
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => addLog('❌ Error WebSocket', 'loss');
    ws.onclose = () => {
        addLog('🔌 Conexión cerrada', 'loss');
        if (botRunning) scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    addLog('🔄 Reconectando...', 'warning');
    if (reconnectInterval) clearInterval(reconnectInterval);

    reconnectInterval = setInterval(async () => {
        if (reconnectAttempts >= MAX_RECONNECT) {
            addLog('❌ Máximos intentos', 'loss');
            clearInterval(reconnectInterval); reconnecting = false; return;
        }
        reconnectAttempts++;

        if (!currentAccountId) { connectDeriv(); return; }

        try {
            const headers = { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${PAT_TOKEN}`, 'Content-Type': 'application/json' };
            const r = await fetch(`${REST_BASE}/trading/v1/options/accounts/${currentAccountId}/otp`, { method: 'POST', headers });
            if (r.ok) {
                const d = await r.json();
                if (d.data?.url) {
                    openWS(d.data.url);
                    reconnecting = false;
                    clearInterval(reconnectInterval);
                }
            }
        } catch {}
    }, RECONNECT_DELAY);
}

async function connectDeriv() {
    addLog('🔗 Conectando a Deriv...', 'info');
    try {
        const headers = { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${PAT_TOKEN}`, 'Content-Type': 'application/json' };
        const accResp = await fetch(`${REST_BASE}/trading/v1/options/accounts`, { headers });
        if (!accResp.ok) throw new Error(`Error ${accResp.status}`);
        const accData = await accResp.json();
        const accounts = accData.data || [];
        if (!accounts.length) throw new Error('No hay cuentas');

        const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
        currentAccountId = account.account_id;
        currentAccountType = account.account_type;
        balance = parseFloat(account.balance || 0);
        addLog(`✅ Cuenta: ${account.account_id} (${currentAccountType.toUpperCase()}) | Balance: $${balance}`, 'success');

        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { method: 'POST', headers });
        if (!otpResp.ok) throw new Error(`OTP ${otpResp.status}`);
        const otpData = await otpResp.json();
        if (!otpData.data?.url) throw new Error('Sin URL OTP');
        openWS(otpData.data.url);
    } catch (e) {
        addLog(`❌ Error conexión: ${e.message}`, 'loss');
        setTimeout(connectDeriv, 5000);
    }
}

// ==================== WEB ====================
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));

app.get('/api/stats', (req, res) => {
    const st = STRATEGY.state;
    res.json({
        balance,
        strategy: {
            id: STRATEGY.id,
            symbol: STRATEGY.symbol,
            contractType: STRATEGY.contractType,
            stake: STRATEGY.stake,
            triggerCount: STRATEGY.triggerCount,
            takeProfit: STRATEGY.takeProfit,
            maxLoss: STRATEGY.maxLoss,
            stopped: st.stopped,
            consecutiveOdds: st.consecutiveOdds,
            totalProfit: st.totalProfit,
            winCount: st.winCount,
            lossCount: st.lossCount,
            totalTrades: st.totalTrades
        },
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => res.status(200).send('🤖 DIGITEVEN BOT activo ' + new Date().toISOString()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Servidor en puerto ${PORT}`));

// ==================== INICIO ====================
console.log('🤖 DIGITEVEN BOT - BACKEND 24/7');
console.log(`📊 ${STRATEGY.symbol} · ${STRATEGY.contractType} · Stake $${STRATEGY.stake} · Trigger: ${STRATEGY.triggerCount} impares`);
console.log(`🎯 TP: $${STRATEGY.takeProfit} | SL: $${STRATEGY.maxLoss}`);
connectDeriv();

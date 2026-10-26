const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🤖 EVEN/ODD CONTRA-BOT - BACKEND 24/7');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const SYMBOLS = ['R_100'];
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_339e0dacd3e55300a4170aa59c7ab178eedc5e18000a961d99ed7766f0d9e4bb'; // ⚠️ REVOCAR YA
const TRIGGER = 3;          // ⬅️ repeticiones del mismo dígito
const STAKE = 1.00;
const LOOKBACK = 50;
const MAX_RECONNECT = 20;
const RECONNECT_DELAY = 5000;

// ==================== ESTADO ====================
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
let botStats = {
    balance: 0,
    totalProfit: 0,
    winCount: 0,
    lossCount: 0,
    totalTrades: 0
};

const symState = {};

SYMBOLS.forEach(s => {
    symState[s] = {
        recentTicks: [],        // 🎲 [{ digit, quote, pipSize, epoch }]
        consecutive: 0,          // repeticiones del MISMO dígito
        lastDigit: null,
        lastQuote: null,
        lastTradedDigit: null,   // dígito sobre el que ya operamos
        pending: false,
        activeContracts: new Map(),
        pipSizeLogged: false
    };
});

const contractSymbolMap = new Map();
// Guardar contexto del trade: qué dígito se repitió y qué contrato se compró
const contractMeta = new Map();

// ==================== LOGS ====================
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 500) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// ==================== EXTRACCIÓN DE DÍGITO ====================
function getLastDigit(quote, pipSize) {
    const ps = (Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 8) ? pipSize : 2;
    const num = typeof quote === 'number' ? quote : parseFloat(quote);
    if (!Number.isFinite(num)) return null;

    const str = num.toFixed(ps);
    const lastChar = str.charAt(str.length - 1);
    const code = lastChar.charCodeAt(0);
    if (code < 48 || code > 57) return null;
    return code - 48;
}

// ==================== TRADING ====================
function executeTrade(sym) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog(`⚠️ [${sym}] WebSocket no disponible`, 'warning');
        return;
    }

    const st = symState[sym];
    if (!st || st.lastDigit === null) return;
    if (st.pending || st.activeContracts.size > 0) return;

    const repeatedDigit = st.lastDigit;
    const isEven = repeatedDigit % 2 === 0;

    // 🎯 Contra-apuesta: si el dígito repetido es PAR → apostar ODD. Si es IMPAR → apostar EVEN.
    const contractType = isEven ? 'DIGITODD' : 'DIGITEVEN';

    st.lastTradedDigit = repeatedDigit;
    st.pending = true;
    currentTradingSymbol = sym;

    addLog(
        `🎯 [${sym}] ${st.consecutive}× dígito ${repeatedDigit} (${isEven ? 'PAR' : 'IMPAR'}) → apuesta ${contractType.replace('DIGIT', '')} | $${STAKE}`,
        'warning'
    );

    ws.send(JSON.stringify({
        proposal: 1,
        amount: STAKE,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: sym
    }));
}

function processResult(contractId, profit, sym) {
    const meta = contractMeta.get(contractId) || {};
    const repeatedDigit = meta.repeatedDigit;
    const contractType = meta.contractType;

    botStats.totalTrades++;
    botStats.totalProfit += profit;
    botStats.balance += profit;

    if (profit > 0) {
        botStats.winCount++;
        addLog(
            `✅ WIN [${sym}] ${contractType.replace('DIGIT', '')} ganó | dígito ${repeatedDigit} NO repitió | +$${profit.toFixed(2)} | Total: $${botStats.totalProfit.toFixed(2)}`,
            'win'
        );
    } else {
        botStats.lossCount++;
        addLog(
            `❌ LOSS [${sym}] ${contractType.replace('DIGIT', '')} perdió | dígito ${repeatedDigit} repitió | -$${Math.abs(profit).toFixed(2)} | Total: $${botStats.totalProfit.toFixed(2)}`,
            'loss'
        );
    }

    if (symState[sym]) {
        symState[sym].activeContracts.delete(contractId);
        symState[sym].pending = false;
    }
    contractSymbolMap.delete(contractId);
    contractMeta.delete(contractId);
}

function processTick(sym, quote, pipSize, epoch) {
    const digit = getLastDigit(quote, pipSize);

    if (digit === null) {
        addLog(`⚠️ [${sym}] TICK INVÁLIDO descartado | quote=${quote} pipSize=${pipSize}`, 'loss');
        return;
    }

    const st = symState[sym];
    if (!st) return;

    if (!st.pipSizeLogged) {
        st.pipSizeLogged = true;
        addLog(`🔍 [${sym}] pip_size=${pipSize} · primer tick ${quote} → dígito ${digit}`, 'info');
    }

    // 🎲 Guardar tick
    st.recentTicks.push({ digit, quote, pipSize, epoch });
    if (st.recentTicks.length > LOOKBACK) st.recentTicks.shift();

    // Racha: cuántas veces seguidas el MISMO dígito
    if (digit === st.lastDigit) {
        st.consecutive++;
    } else {
        st.consecutive = 1;
        // Si cambió el dígito, reseteamos el "ya operado" para permitir nueva entrada
        if (digit !== st.lastTradedDigit) {
            st.lastTradedDigit = null;
        }
    }

    st.lastDigit = digit;
    st.lastQuote = quote;

    const isEven = digit % 2 === 0;

    // ⚡ TRIGGER: N repeticiones del mismo dígito → contra-apuesta
    const triggered = botRunning && st.consecutive >= TRIGGER && st.lastTradedDigit !== digit;

    if (triggered) {
        if (st.activeContracts.size === 0 && !st.pending) {
            addLog(
                `⚡ [${sym}] ${TRIGGER}× dígito ${digit} (${isEven ? 'PAR' : 'IMPAR'}) │ ${quote} │ ENTRANDO AHORA`,
                'warning'
            );
            executeTrade(sym);
            return;
        } else {
            st.lastTradedDigit = digit;
            addLog(
                `⚡ [${sym}] Trigger ${TRIGGER}× dígito ${digit} pero bot ocupado — skip │ ${quote}`,
                'warning'
            );
            return;
        }
    }

    // 🎲 Log normal
    addLog(
        `🎲 [${sym}] ${digit} (${isEven ? 'P' : 'I'}) · racha ${st.consecutive}/${TRIGGER} │ ${quote}`,
        'digit'
    );
}

// ==================== WEBSOCKET ====================
function handleMsg(data) {
    if (data.error) {
        addLog(`❌ Error: ${data.error.message || data.error}`, 'loss');
        return;
    }

    if (data.msg_type === 'balance' || data.balance) {
        const bal = data.balance?.balance || data.balance;
        if (bal && typeof bal === 'number') botStats.balance = parseFloat(bal);
        return;
    }

    if (data.tick) {
        processTick(data.tick.symbol, data.tick.quote, data.tick.pip_size, data.tick.epoch);
        return;
    }

    if (data.proposal && botRunning) {
        ws.send(JSON.stringify({ buy: data.proposal.id, price: data.proposal.ask_price }));
        return;
    }

    if (data.buy) {
        const id = data.buy.contract_id;
        const sym = currentTradingSymbol || 'UNKNOWN';
        const st = symState[sym];

        if (st) {
            st.activeContracts.set(id, { id });
            st.pending = false;

            // Guardar contexto del trade para el resultado
            const repeatedDigit = st.lastDigit;
            const contractType = repeatedDigit % 2 === 0 ? 'DIGITODD' : 'DIGITEVEN';
            contractMeta.set(id, { repeatedDigit, contractType });
        }

        contractSymbolMap.set(id, sym);
        currentTradingSymbol = null;

        addLog(`📋 [${sym}] Contrato abierto: ${id}`, 'info');

        const monitor = setInterval(() => {
            if (!symState[sym]?.activeContracts.has(id)) { clearInterval(monitor); return; }
            if (ws?.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: id }));
        }, 1200);
        setTimeout(() => clearInterval(monitor), 35000);
        return;
    }

    if (data.proposal_open_contract?.is_sold) {
        const c = data.proposal_open_contract;
        const profit = parseFloat(c.profit || 0);
        const cid = c.contract_id;
        const sym = contractSymbolMap.get(cid) || 'UNKNOWN';

        if (symState[sym]?.activeContracts.has(cid)) {
            processResult(cid, profit, sym);
        }
        return;
    }
}

function openWS(url) {
    if (ws) { try { ws.close(); } catch (e) {} }
    ws = new WebSocket(url);

    ws.onopen = () => {
        addLog('✅ WebSocket conectado!', 'success');

        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        SYMBOLS.forEach(sym => {
            ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        });

        addLog(`📊 Suscrito a ${SYMBOLS.length} pares`, 'success');

        if (!botRunning) {
            botRunning = true;
            addLog(`🚀 BOT INICIADO | Trigger: ${TRIGGER} repeticiones · Stake $${STAKE}`, 'success');
        }
    };

    ws.onmessage = (e) => {
        try { handleMsg(JSON.parse(e.data)); } catch (err) {}
    };

    ws.onerror = () => addLog('❌ Error WebSocket', 'loss');

    ws.onclose = () => {
        addLog('🔌 Conexión cerrada', 'loss');
        SYMBOLS.forEach(sym => {
            if (symState[sym]) {
                symState[sym].consecutive = 0;
                symState[sym].pending = false;
                symState[sym].lastTradedDigit = null;
            }
        });
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
            addLog('❌ Máximos intentos', 'loss');
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
            const otpResp = await fetch(
                `${REST_BASE}/trading/v1/options/accounts/${currentAccountId}/otp`,
                { method: 'POST', headers }
            );
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

        const account = allAccounts.find(a => a.account_type === 'demo') || allAccounts[0];
        currentAccountId = account.account_id;
        currentAccountType = account.account_type;
        botStats.balance = parseFloat(account.balance || 0);

        addLog(`✅ Cuenta: ${account.account_id} (${currentAccountType.toUpperCase()}) | Balance: $${botStats.balance}`, 'success');

        const otpResp = await fetch(
            `${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`,
            { method: 'POST', headers }
        );
        if (!otpResp.ok) throw new Error(`Error OTP: ${otpResp.status}`);

        const otpData = await otpResp.json();
        if (!otpData.data?.url) throw new Error('No se obtuvo URL');

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

app.get('/api/verify', (req, res) => {
    const quote = req.query.quote;
    const pipSize = parseInt(req.query.pip_size) || 2;
    const digit = getLastDigit(quote, pipSize);
    res.json({
        input: { quote, pipSize },
        formatted: (() => { try { return Number(quote).toFixed(pipSize); } catch { return null; } })(),
        digit,
        isEven: digit !== null ? digit % 2 === 0 : null
    });
});

app.get('/api/ticks', (req, res) => {
    const sym = SYMBOLS[0];
    const st = symState[sym];
    res.json({
        symbol: sym,
        lastQuote: st.lastQuote,
        lastDigit: st.lastDigit,
        consecutive: st.consecutive,
        trigger: TRIGGER,
        ticks: [...st.recentTicks].reverse()
    });
});

app.get('/api/stats', (req, res) => {
    const sym = SYMBOLS[0];
    const st = symState[sym];
    res.json({
        balance: botStats.balance,
        totalProfit: botStats.totalProfit,
        winCount: botStats.winCount,
        lossCount: botStats.lossCount,
        totalTrades: botStats.totalTrades,
        symbol: sym,
        lastQuote: st.lastQuote,
        lastDigit: st.lastDigit,
        lastDigitType: st.lastDigit !== null ? (st.lastDigit % 2 === 0 ? 'PAR' : 'IMPAR') : null,
        consecutive: st.consecutive,
        trigger: TRIGGER,
        nextBet: st.lastDigit !== null
            ? (st.lastDigit % 2 === 0 ? 'DIGITODD' : 'DIGITEVEN')
            : null,
        recentTicks: [...st.recentTicks].reverse().slice(0, 30),
        logs: tradeLogs.slice(0, 100)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🤖 EVEN/ODD BOT - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
    console.log(`🔗 https://digitdiff-bot-production.up.railway.app`);
});

// ==================== INICIO ====================
console.log(`📊 ${SYMBOLS.length} pares · Trigger: ${TRIGGER} repeticiones · Stake: $${STAKE}`);
console.log('⚡ Estrategia: dígito se repite 3 veces → apostar al CONTRARIO (PAR→ODD, IMPAR→EVEN)');

connectDeriv();

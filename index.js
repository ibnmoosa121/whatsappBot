const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Allow overriding the data directory via environment variable for Render persistence
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BALANCE_FILE = path.join(DATA_DIR, 'balance.json');
const SPECIAL_GROUPS = [
    '120363424806790533@g.us',
    '120363315388298656@g.us'
];

// Persistent ledger balances (loaded from file if it exists)
let balances = {};

if (fs.existsSync(BALANCE_FILE)) {
    try {
        const data = fs.readFileSync(BALANCE_FILE, 'utf8');
        balances = JSON.parse(data);
        
        // Migrate old global balance format if necessary (Optional)
        if (balances.balance !== undefined && Object.keys(balances).length === 1) {
            balances = {}; // Reset or just ignore the old format
        }
    } catch (err) {
        console.error('Error loading balances:', err);
    }
}

// Helper to save balances after changes
function saveBalances() {
    try {
        fs.writeFileSync(BALANCE_FILE, JSON.stringify(balances, null, 2), 'utf8');
    } catch (err) {
        console.error('Error saving balances:', err);
    }
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_DIR }), // Saves login session to the persistent directory
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for cloud hosting (Render/Docker)
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above with WhatsApp!');
});

client.on('ready', () => {
    console.log('Ledger Bot is online!');
});

client.on('message_create', async (msg) => {
    // When YOU send a message, the chat ID is in msg.to. Otherwise, it's msg.from.
    const chatId = msg.fromMe ? msg.to : msg.from;
    const isGroup = chatId.includes('@g.us');
    console.log(`📨 [${isGroup ? 'Group' : 'DM'}] Chat ID: ${chatId}`);

    const text = msg.body.trim();

    // Regex to match +100 or -50, with an optional 3 or 4 letter reference (e.g., +50000 AMR)
    const match = text.match(/^([\+\-])\s?(\d+(\.\d+)?)(?:\s+([a-zA-Z]{3,4}))?$/);
    
    // Regex to match "rate 3.85"
    const rateMatch = text.match(/^rate\s+(\d+(\.\d+)?)$/i);

    if (rateMatch) {
        const newRate = parseFloat(rateMatch[1]);
        balances['_rate'] = newRate;
        saveBalances();
        msg.reply(
            `🤖 *Rate Updated*\n\n` +
            `💱 *New Rate:* ${newRate}\n` +
            `━━━━━━━━━━━━━━\n` +
            `💡 _All future deposits will use this rate._`
        );
    } else if (match) {
        const operator = match[1];
        const rawAmount = parseFloat(match[2]);
        const reference = match[4] ? match[4].toUpperCase() : null;

        // Check if we are in the special group
        const isSpecialGroup = SPECIAL_GROUPS.includes(chatId);
        const rate = balances['_rate'] || 3.82;

        if (operator === '+') {
            // + Means USDT is being paid. Convert it and add to SAR balance.
            const multiplier = isSpecialGroup ? rate : 1;
            const convertedAmount = Math.round((rawAmount * multiplier) * 100) / 100;
            
            balances[chatId] = Math.round(((balances[chatId] || 0) + convertedAmount) * 100) / 100;
            saveBalances();

            if (isSpecialGroup) {
                msg.reply(
                    `🤖 *Deposit Received*\n\n` +
                    `📥 *USDT Sent:* ${rawAmount}\n` +
                    `💱 *Rate:* ${rate}\n` +
                    `➕ *SAR Added:* ${convertedAmount}\n` +
                    (reference ? `📝 *Ref:* ${reference}\n` : '') +
                    `━━━━━━━━━━━━━━\n` +
                    `💰 *Current Balance:* ${balances[chatId]} SAR`
                );
            } else {
                msg.reply(
                    `🤖 *Deposit Received*\n\n` +
                    `📥 *SAR Received:* ${convertedAmount}\n` +
                    (reference ? `📝 *Ref:* ${reference}\n` : '') +
                    `━━━━━━━━━━━━━━\n` +
                    `💰 *Current Balance:* ${balances[chatId]} SAR`
                );
            }
        } else if (operator === '-') {
            // - Means SAR is being paid out. Deduct exactly the stated amount.
            const deductAmount = rawAmount;
            
            balances[chatId] = Math.round(((balances[chatId] || 0) - deductAmount) * 100) / 100;
            saveBalances();

            if (isSpecialGroup) {
                msg.reply(
                    `🤖 *Payment Sent*\n\n` +
                    `🔻 *SAR Deducted:* ${deductAmount}\n` +
                    (reference ? `📝 *Ref:* ${reference}\n` : '') +
                    `━━━━━━━━━━━━━━\n` +
                    `💰 *Current Balance:* ${balances[chatId]} SAR`
                );
            } else {
                msg.reply(
                    `🤖 *Payment Sent*\n\n` +
                    `🔻 *SAR Paid:* ${deductAmount}\n` +
                    (reference ? `📝 *Ref:* ${reference}\n` : '') +
                    `━━━━━━━━━━━━━━\n` +
                    `💰 *Current Balance:* ${balances[chatId]} SAR`
                );
            }
        }
    } else if (text.toLowerCase() === 'balance') {
        const currentBalance = balances[chatId] || 0;
        const currentRate = balances['_rate'] || 3.82;
        const isSpecialGroup = SPECIAL_GROUPS.includes(chatId);
        const currency = isSpecialGroup ? ' SAR' : ' SAR';

        msg.reply(
            `🤖 *Ledger Status*\n\n` +
            `📊 *Total Balance:* ${currentBalance}${currency}\n` +
            (isSpecialGroup ? `💱 *Current Rate:* ${currentRate}\n` : '') +
            `━━━━━━━━━━━━━━`
        );
    }
});

client.initialize();

// Setup a simple Express App to accept HTTP pings unconditionally.
const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Ledger Bot is awake and running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server is listening on port ${PORT} to keep the bot alive!`);
});


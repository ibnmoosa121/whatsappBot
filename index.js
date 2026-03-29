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
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] // Memory-saving args for cloud hosting (Render/Railway Docker)
    }
});

let currentQR = '';

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    currentQR = qr;
    console.log('\n=============================================');
    console.log('🔗 CLICK THIS LINK TO SEE YOUR QR CODE IMG:');
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    console.log('=============================================\n');
});

client.on('ready', () => {
    currentQR = '';
    console.log('Ledger Bot is online!');
});

// Auto-healing: If connection drops, crash the app so Railway auto-reboots and reconnects it fresh
client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp Disconnected:', reason);
    console.log('Rebooting container to reconnect...');
    process.exit(1); 
});

client.on('auth_failure', msg => {
    console.error('❌ Authentication failed:', msg);
    process.exit(1);
});

client.on('message_create', async (msg) => {
    // When YOU send a message, the chat ID is in msg.to. Otherwise, it's msg.from.
    const chatId = msg.fromMe ? msg.to : msg.from;
    const isGroup = chatId.includes('@g.us');
    console.log(`📨 [${isGroup ? 'Group' : 'DM'}] Chat ID: ${chatId}`);

    const text = msg.body.trim();
    console.log(`🔍 Received text: "${text}"`);

    // Regex to match +100 or -50, with an optional 3 or 4 letter reference (e.g., +50000 AMR)
    const match = text.match(/^([\+\-])\s?(\d+(\.\d+)?)(?:\s+([a-zA-Z]{3,4}))?$/);
    console.log(`🔍 Did it match the math rule? ${match ? 'YES' : 'NO'}`);
    
    // Regex to match "rate 3.85"
    const rateMatch = text.match(/^rate\s+(\d+(\.\d+)?)$/i);
    
    // Regex to match "edit 1500" or "edit -500"
    const editMatch = text.match(/^edit\s+(-?\d+(\.\d+)?)$/i);

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
    } else if (editMatch) {
        const newBalance = parseFloat(editMatch[1]);
        balances[chatId] = Math.round(newBalance * 100) / 100;
        saveBalances();

        const isSpecialGroup = SPECIAL_GROUPS.includes(chatId);
        const currency = isSpecialGroup ? ' SAR' : ' SAR';

        msg.reply(
            `🤖 *Balance Manually Edited*\n\n` +
            `⚠️ *Admin Override Applied*\n` +
            `━━━━━━━━━━━━━━\n` +
            `💰 *New Fixed Balance:* ${balances[chatId]}${currency}`
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
    if (currentQR) {
        res.send(`
            <html>
            <body style="display:flex; justify-content:center; align-items:center; height:100vh; font-family: sans-serif; background-color: #f0f2f5; margin: 0;">
                <div style="text-align:center; padding: 40px; background: white; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                    <h2 style="margin-top: 0; color: #128c7e;">WhatsApp Login</h2>
                    <p style="color: #666; margin-bottom: 25px;">Scan this QR Code using the WhatsApp app<br/><b>(Settings > Linked Devices > Link a Device)</b></p>
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" alt="QR Code" style="border: 1px solid #ddd; padding: 10px; border-radius: 5px;" />
                    <p style="color: #888; margin-top: 25px; font-size: 14px;"><em>Code not scanning or expired? Just refresh this page!</em></p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send('Ledger Bot is awake and running!');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server is listening on port ${PORT} to keep the bot alive!`);
});


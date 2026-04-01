const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Allow overriding the data directory via environment variable for Render persistence
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BALANCE_FILE = path.join(DATA_DIR, 'balance.json');
const SPECIAL_GROUPS = [
    '120363424806790533@g.us', // Name: "Test"
    '120363315388298656@g.us'  // Name: "SBT"
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

    // 1. Aggressive Watchdog: Pings WhatsApp servers every 5 minutes
    setInterval(async () => {
        try {
            const state = await client.getState();
            if (state && state !== 'CONNECTED') {
                console.log('❌ Watchdog detected broken connection:', state);
                process.exit(1);
            }
        } catch (err) {
            console.error('❌ Watchdog crashed! Browser silently froze. Rebooting...', err);
            process.exit(1);
        }
    }, 5 * 60 * 1000);

    // 2. Memory Wipe: Reboot gracefully every 12 hours exactly
    setTimeout(() => {
        console.log('🔄 Performing 12-hour scheduled memory clear...');
        process.exit(1);
    }, 12 * 60 * 60 * 1000);
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

    // Clean out commas so 1,500 becomes 1500 automatically before processing!
    const cleanText = text.replace(/,/g, '');

    // Regex to match "rate 3.85"
    const rateMatch = cleanText.match(/^rate\s+(\d+(\.\d+)?)$/i);
    
    // Regex to match "edit 1500" or "edit -500"
    const editMatch = cleanText.match(/^edit\s+(-?\d+(\.\d+)?)$/i);
    
    // Super Smart Math Matcher:
    // Matches sign (+/-), number, optional operator (* or /), second number, and optional reference string (AMR)
    // Works with: "+100" | "100 * 3.82" | "+5000 / 3.82" | "-50 AMR"
    const mathMatch = cleanText.match(/^([\+\-]?)?\s*(\d+(\.\d+)?)(?:\s*([\*\/])\s*(\d+(\.\d+)?))?(?:\s+([a-zA-Z]{3,4}))?$/);
    
    // Ensure the user typed an actual operator or sign (so accidentally typing "100" alone doesn't trigger a deposit)
    const isMathCommand = mathMatch && (mathMatch[1] !== '' || mathMatch[4] !== undefined);
    console.log(`🔍 Did it match the NEW smart math rule? ${isMathCommand ? 'YES' : 'NO'}`);

    // Helper to send threaded balance updates and pin them natively to the chat
    async function sendAndPinBalance(targetChatId, triggerMsg, responseText) {
        const lastMsgId = balances['_lastMsg_' + targetChatId];
        let sentMsg;
        try {
            if (lastMsgId) {
                // Reply to the strictly previous balance message to magically chain the entire timeline
                sentMsg = await client.sendMessage(targetChatId, responseText, { quotedMessageId: lastMsgId });
            } else {
                // First time: just reply to the user's math command normally
                sentMsg = await triggerMsg.reply(responseText);
            }
        } catch (e) {
            console.error("Timeline broken because ancient message was deleted. Rebuilding thread...", e.message);
            sentMsg = await triggerMsg.reply(responseText);
        }

        if (sentMsg && sentMsg.id) {
            balances['_lastMsg_' + targetChatId] = sentMsg.id._serialized;
            saveBalances();

            // Attempt to Pin the message for 30 days (2592000 seconds) inside WhatsApp inherently
            try {
                if (typeof sentMsg.pin === 'function') {
                    await sentMsg.pin(2592000);
                }
            } catch (pinErr) {
                console.log("Could not vividly pin message (bot might not be group admin!):", pinErr.message);
            }
        }
    }

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

        await sendAndPinBalance(chatId, msg, 
            `🤖 *Balance Manually Edited*\n\n` +
            `⚠️ *Admin Override Applied*\n` +
            `━━━━━━━━━━━━━━\n` +
            `💰 *New Fixed Balance:* ${balances[chatId]} SAR`
        );
    } else if (isMathCommand) {
        // Evaluate the inline math dynamically to pure SAR
        const signStr = mathMatch[1] || '+'; // Default to '+' if they wrote an equation like "100 * 3.82"
        const num1 = parseFloat(mathMatch[2]);
        const mathOp = mathMatch[4];
        const num2 = mathMatch[5] ? parseFloat(mathMatch[5]) : null;
        const reference = mathMatch[7] ? mathMatch[7].toUpperCase() : null;

        let calculatedAmount = num1;
        let mathString = `${num1}`;
        
        if (mathOp === '*') {
            calculatedAmount = num1 * num2;
            mathString = `${num1} × ${num2}`;
        } else if (mathOp === '/') {
            calculatedAmount = num1 / num2;
            mathString = `${num1} ÷ ${num2}`;
        }

        // Round strictly to 2 decimal places
        calculatedAmount = Math.round(calculatedAmount * 100) / 100;

        if (signStr === '+') {
            balances[chatId] = Math.round(((balances[chatId] || 0) + calculatedAmount) * 100) / 100;
            saveBalances();

            await sendAndPinBalance(chatId, msg, 
                `🤖 *Deposit Received*\n\n` +
                (mathOp ? `🧮 *Calculation:* ${mathString}\n` : '') +
                `➕ *SAR Added:* ${calculatedAmount}\n` +
                (reference ? `📝 *Ref:* ${reference}\n` : '') +
                `━━━━━━━━━━━━━━\n` +
                `💰 *Current Balance:* ${balances[chatId]} SAR`
            );
        } else if (signStr === '-') {
            balances[chatId] = Math.round(((balances[chatId] || 0) - calculatedAmount) * 100) / 100;
            saveBalances();

            await sendAndPinBalance(chatId, msg, 
                `🤖 *Payment Sent*\n\n` +
                (mathOp ? `🧮 *Calculation:* ${mathString}\n` : '') +
                `🔻 *SAR Deducted:* ${calculatedAmount}\n` +
                (reference ? `📝 *Ref:* ${reference}\n` : '') +
                `━━━━━━━━━━━━━━\n` +
                `💰 *Current Balance:* ${balances[chatId]} SAR`
            );
        }
    } else if (text.toLowerCase() === 'balance') {
        const currentBalance = balances[chatId] || 0;

        await sendAndPinBalance(chatId, msg, 
            `🤖 *Ledger Status*\n\n` +
            `📊 *Total Balance:* ${currentBalance} SAR\n` +
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


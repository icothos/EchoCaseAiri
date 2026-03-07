import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';

// 앱 루트 및 stage-tamagotchi .env.local 로드
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../apps/stage-tamagotchi/.env.local') });

const CHZZK_CLIENT_ID = process.env.CHZZK_CLIENT_ID || '';
const CHZZK_CLIENT_SECRET = process.env.CHZZK_CLIENT_SECRET || '';

// Redirect URI for local local testing. This MUST match the one registered in the Chzzk Developers Console.
const REDIRECT_URI = 'http://localhost:12393';
const PORT = 12393;

if (!CHZZK_CLIENT_ID || !CHZZK_CLIENT_SECRET) {
    console.error('❌ Missing CHZZK_CLIENT_ID or CHZZK_CLIENT_SECRET in .env');
    process.exit(1);
}

const app = express();
const stateStr = nanoid();

app.get('/login', (req, res) => {
    // Official Chzzk OAuth authorize endpoint usually maps to this.
    const authorizeUrl = `https://chzzk.naver.com/account-interlock?clientId=${CHZZK_CLIENT_ID}&redirectUri=${encodeURIComponent(REDIRECT_URI)}&state=${stateStr}`;
    res.redirect(authorizeUrl);
});

app.get('/', async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
        return res.send(`<h1>Chzzk Auth Server</h1><p>Click <a href="/login">here</a> to login.</p>`);
    }

    if (state !== stateStr) {
        return res.status(400).send('❌ Authentication failed: state mismatch.');
    }

    console.log('✅ Received authorization code. Fetching access token...');

    try {
        const response = await axios.post('https://chzzk.naver.com/auth/v1/token', {
            grantType: 'authorization_code',
            clientId: CHZZK_CLIENT_ID,
            clientSecret: CHZZK_CLIENT_SECRET,
            code: code as string,
            state: state as string,
        });

        const tokenData = response.data.content;
        
        const tokenFilePath = path.resolve(process.cwd(), '.chzzk-token.json');
        fs.writeFileSync(tokenFilePath, JSON.stringify(tokenData, null, 2));

        console.log(`✅ Access token successfully saved to ${tokenFilePath}`);
        res.send('<h1>✅ Authentication Success!</h1><p>You can close this window and start the adapter.</p>');

        // Shutdown the server gracefully
        setTimeout(() => {
            console.log('🛑 Shutting down local auth server...');
            process.exit(0);
        }, 1000);

    } catch (e: any) {
        console.error('❌ Failed to fetch access token:', e.response?.data || e.message);
        res.status(500).send(`<h1>❌ Authentication Error</h1><p>${JSON.stringify(e.response?.data || e.message)}</p>`);
    }
});

app.listen(PORT, () => {
    console.log('======================================================');
    console.log(` 🔑 Chzzk Local Auth Server is running on port ${PORT}`);
    console.log('======================================================');
    console.log(` 1. Ensure your Chzzk Developers App has this exact Callback URI registered:`);
    console.log(`    -> ${REDIRECT_URI}`);
    console.log(` 2. To obtain the Access Token, open the following link in your browser:`);
    console.log(`    -> http://localhost:${PORT}/login`);
});

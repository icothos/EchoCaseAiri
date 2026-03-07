import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// 앱 루트 및 stage-tamagotchi의 .env 파일을 찾아서 로드합니다
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../apps/stage-tamagotchi/.env.local') });

// Configuration
const CHZZK_CHANNEL_ID = process.env.CHZZK_CHANNEL_ID || '';
const CHZZK_CLIENT_ID = process.env.CHZZK_CLIENT_ID || '';
const CHZZK_CLIENT_SECRET = process.env.CHZZK_CLIENT_SECRET || '';
const AIRI_WS_URL = process.env.VITE_AIRI_WS_URL || 'ws://127.0.0.1:6121/ws';

if (!CHZZK_CHANNEL_ID || !CHZZK_CLIENT_ID || !CHZZK_CLIENT_SECRET) {
    console.error('❌ Missing CHZZK_CHANNEL_ID, CHZZK_CLIENT_ID, or CHZZK_CLIENT_SECRET in environment variables.');
    process.exit(1);
}

// ----------------------------------------------------
// Airi VTuber WS (Destination)
// ----------------------------------------------------
let vtuberWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function connectVtuberWs() {
    if (vtuberWs) return;

    console.log(`🔌 [Airi WS] Connecting to ${AIRI_WS_URL}...`);
    vtuberWs = new WebSocket(AIRI_WS_URL);

    vtuberWs.on('open', () => {
        console.log('✅ [Airi WS] Connected to Open-LLM-VTuber (Airi) Server!');
        const announceEvent = {
            type: 'module:announce',
            data: {
                name: 'chzzk-adapter',
                index: 0,
                identity: { kind: 'plugin', plugin: { id: 'chzzk-adapter' } }
            }
        };
        vtuberWs?.send(JSON.stringify(announceEvent));
    });

    vtuberWs.on('message', (data) => {
        try {
            const event = JSON.parse(data.toString());
            if (event.type === 'transport:connection:heartbeat' && event.data?.kind === 'ping') {
                vtuberWs?.send(JSON.stringify({
                    type: 'transport:connection:heartbeat',
                    data: { kind: 'pong', at: Date.now() }
                }));
            }
        } catch (e) {
            // ignore
        }
    });

    vtuberWs.on('error', (err) => console.error(`❌ [Airi WS] WebSocket Error:`, err.message));
    vtuberWs.on('close', () => {
        console.warn('❌ [Airi WS] Disconnected. Reconnecting in 5 seconds...');
        vtuberWs = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectVtuberWs, 5000);
    });
}

function sendToAiri(payload: any) {
    if (vtuberWs && vtuberWs.readyState === WebSocket.OPEN) {
        vtuberWs.send(JSON.stringify(payload));
    }
}

// ----------------------------------------------------
// Official Chzzk API Client
// ----------------------------------------------------
// ----------------------------------------------------
// Official Chzzk API + Unofficial NPM Client Hybrid
// ----------------------------------------------------
import { ChzzkClient } from 'chzzk';

let chzzkAccessToken = '';

async function fetchAccessToken() {
    console.log("🔐 [Chzzk API] Loading Access Token from local file...");
    const tokenFilePath = path.resolve(process.cwd(), '.chzzk-token.json');
    if (!fs.existsSync(tokenFilePath)) {
        console.error("❌ Token file not found. Please run 'pnpm auth' first.");
        throw new Error('Token missing');
    }
    
    try {
        const tokenData = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
        chzzkAccessToken = tokenData.accessToken;
        console.log(`✅ [Chzzk API] Access Token loaded. (For reference/future use: ${chzzkAccessToken.substring(0, 5)}...)`);
    } catch(e) {
        console.error("❌ Failed to parse token file.", e);
        throw e;
    }
}

async function startChzzkClient() {
    console.log(`📡 [Chzzk] Starting Hybrid client for channel: ${CHZZK_CHANNEL_ID}`);
    // Note: The chzzk npm library handles the complex internal chat mapping. 
    // We instantiate it here to handle the actual WebSocket routing stably.
    const client = new ChzzkClient();
    
    const chatClient = client.chat({
        channelId: CHZZK_CHANNEL_ID,
    });

    chatClient.on('connect', () => {
        console.log(`✅ [Chzzk] Successfully connected to Chzzk Chat Server!`);
    });

    chatClient.on('disconnect', () => {
        console.warn(`❌ [Chzzk] Disconnected from Chzzk Chat Server.`);
    });

    chatClient.on('chat', (message) => {
        const userName = message.profile?.nickname || '익명';
        const content = message.message || '';
        
        console.log(`[Chat] ${userName}: ${content}`);

        sendToAiri({
            type: 'input:text',
            data: { text: `[${userName}님이 말했습니다]: ${content}` }
        });
    });

    chatClient.on('donation', (message) => {
        const userName = message.profile?.nickname || '익명';
        const amount = message.extras?.payAmount || 0;
        const donateText = message.message || '';

        console.log(`💰 [Donation] ${userName} ${amount}원: ${donateText}`);

        const hotContent = `후원자 ${userName}님 ${amount}원 후원${donateText ? ` (메시지: ${donateText})` : ''}`;
        
        sendToAiri({
            type: 'input:text',
            data: {
                text: `[${userName}님이 ${amount}원 후원했습니다!] ${donateText}`,
                contextUpdates: [{
                    id: nanoid(),
                    contextId: nanoid(),
                    content: hotContent,
                    metadata: { type: 'donation', value: 15.0, duration: 60.0 }
                }]
            }
        });
        console.log(`💎 [Donation] Injected to HotPool: ${hotContent}`);
    });

    try {
        await chatClient.connect();
    } catch (e: any) {
        console.error('❌ [Chzzk] Failed to connect to chat server.');
        console.error(e.message);
        console.log("💡 Tip: The target Chzzk channel might need to be 'LIVE' to connect to the chat server.");
        process.exit(1);
    }
}

async function main() {
    console.log("===============================================");
    console.log("  EchoCast - Chzzk Adapter (Hybrid V2)");
    console.log("===============================================");
    
    connectVtuberWs();
    
    try {
        await fetchAccessToken();
        await startChzzkClient();
    } catch (e) {
        console.error("Initialization Failed.");
    }
}

main().catch(console.error);

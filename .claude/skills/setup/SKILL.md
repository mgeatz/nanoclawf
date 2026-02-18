---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure email, verify IMAP/SMTP + Ollama + OpenCode, or start the service. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup (OpenCode + Email)

**Principle:** Fix problems, don't describe them. If something is missing, install it. Only pause for user action when genuinely needed (credentials, choices).

## 1. Check Environment

Verify prerequisites:

```bash
node --version    # >= 20
which opencode || ls ~/.opencode/bin/opencode  # OpenCode CLI
ollama list       # Ollama running with models
```

**If Node.js missing:** Install via brew or nvm.
**If OpenCode missing:** `curl -fsSL https://opencode.ai/install | bash`
**If Ollama missing:** `brew install ollama && ollama serve` (background), then `ollama pull qwen2.5-coder:32b`

## 2. Install Dependencies

```bash
npm install
npm run build
```

Fix build errors before proceeding.

## 3. Configure .env

Check if `.env` exists. If not, copy from `.env.example`:

```bash
cp .env.example .env
```

AskUserQuestion for each required value:
- `EMAIL_ADDRESS` — The email address NanoClaw uses (self-to-self)
- `EMAIL_PASSWORD` — App password or account password
- `IMAP_HOST` / `IMAP_PORT` — IMAP server (e.g., 127.0.0.1:1143 for Proton Bridge, imap.gmail.com:993)
- `SMTP_HOST` / `SMTP_PORT` — SMTP server (e.g., 127.0.0.1:1025 for Proton Bridge, smtp.gmail.com:587)
- `NOTIFICATION_EMAIL` — Where agent responses go (can be a different address)
- `MAIN_TAG` — Tag for the admin channel (default: ADMIN)
- `ASSISTANT_NAME` — Bot name (default: Andy)

## 4. Verify Email Connection

Run `npm run dev` briefly and check logs for:
- "Connected to IMAP server"
- No SSL errors

**Common issues:**
- `ERR_SSL_PACKET_LENGTH_TOO_LONG`: Wrong port/TLS mode. Port 993/465 = implicit TLS. Port 1143/1025/587 = STARTTLS.
- Auth failures: Check credentials. For Gmail, use App Password. For Proton Bridge, ensure Bridge is running.

## 5. Verify OpenCode + Ollama

```bash
echo "Say hello" | ~/.opencode/bin/opencode run --format json
```

Should produce NDJSON output with a text response.

## 6. Start as Service

Create a launchd plist (macOS):

```bash
cat > ~/Library/LaunchAgents/com.nanoclaw.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nanoclaw</string>
    <key>WorkingDirectory</key><string>PROJECT_PATH</string>
    <key>ProgramArguments</key>
    <array>
        <string>NODE_PATH</string>
        <string>dist/index.js</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>PROJECT_PATH/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key><string>PROJECT_PATH/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF
```

Replace `PROJECT_PATH` and `NODE_PATH` with actual values.

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## 7. Test

Send a self-to-self email with subject `[ADMIN] Hello` and verify:
1. NanoClaw picks it up (check logs)
2. Agent processes it
3. Response arrives at NOTIFICATION_EMAIL

Monitor dashboard: `open http://localhost:3700`

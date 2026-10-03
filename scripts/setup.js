#!/usr/bin/env node
/**
 * AI Gateway - Project Setup Script
 * Copies .env.example to .env and prints quickstart instructions
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Copy .env.example → .env
const envExample = path.join(ROOT, '.env.example');
const envFile = path.join(ROOT, '.env');

if (!fs.existsSync(envFile)) {
  fs.copyFileSync(envExample, envFile);
  console.log('✅ Created .env from .env.example');
} else {
  console.log('ℹ️  .env already exists, skipping copy');
}

// Also copy to server package
const serverEnv = path.join(ROOT, 'packages', 'server', '.env');
if (!fs.existsSync(serverEnv)) {
  fs.copyFileSync(envExample, serverEnv);
  console.log('✅ Created packages/server/.env');
}

console.log(`
╔══════════════════════════════════════════════════════════╗
║          🚀 AI Gateway — Quick Start Guide               ║
╚══════════════════════════════════════════════════════════╝

1. EDIT YOUR .env FILE:
   - Add your OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
   - Change JWT_SECRET to a secure random string

2. START INFRASTRUCTURE (Redis + PostgreSQL):
   docker-compose up -d redis postgres

3. INSTALL DEPENDENCIES:
   npm install

4. RUN IN DEVELOPMENT:
   npm run dev:server     → API server on :3001
   npm run dev:worker     → Background job worker  
   npm run dev:dashboard  → React dashboard on :3000

   OR run all at once:
   npm run dev

5. OPEN THE DASHBOARD:
   http://localhost:3000
   Login: admin@gateway.local / admin123

6. TEST THE API:
   POST http://localhost:3001/api/v1/gateway/completions
   Headers: X-Api-Key: demo-api-key-change-in-production
   Body: { "userMessage": "Hello, world!" }

7. RUN LOAD TESTS (requires k6):
   npm run test:load

8. FULL DOCKER DEPLOYMENT:
   docker-compose up -d

📖 API Endpoints:
   POST  /api/v1/gateway/completions     → Submit LLM request
   GET   /api/v1/gateway/requests/:id   → Poll job status
   POST  /api/v1/admin/auth/login        → Dashboard login
   GET   /api/v1/admin/dashboard/overview → Stats
   GET   /api/v1/admin/providers         → Provider health
   GET   /api/v1/admin/tenants           → Tenant management

🔐 Default credentials:
   Admin: admin@gateway.local / admin123
   API Key: demo-api-key-change-in-production
`);

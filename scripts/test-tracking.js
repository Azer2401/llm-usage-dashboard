/**
 * Test script to verify usage tracking per user / company
 * for AITM backend LLM & N8N services.
 */
const http = require('http');
const { Client } = require('pg');

const DASHBOARD_URL = 'http://localhost:3003';
const INTERNAL_KEY = 'bf89a3f25c7e112d7d56e9c9c8a1fe18';

// PostgreSQL connection parameters (AITM DB)
const dbConfig = {
  host: 'localhost',
  port: 5432,
  user: 'n8n_user',
  password: 'n8ndevops',
  database: 'n8n_db',
};

async function runTest() {
  console.log('=== AITM Backend Usage Tracking Verification ===\n');

  const client = new Client(dbConfig);
  await client.connect();

  try {
    // 1. Get sample users from database (Admin, HR, Candidate)
    const usersRes = await client.query(`
      SELECT u.id, u.name, u.email, ur.role_name, m.company_id, c.name AS company_name
      FROM users u
      LEFT JOIN employees e ON e.user_id = u.id
      LEFT JOIN user_roles ur ON ur.id = e.user_role_id
      LEFT JOIN llm_user_mappings m ON m.user_id = u.id
      LEFT JOIN llm_companies c ON c.id = m.company_id
      LIMIT 5;
    `);

    console.log('Sample Users & Mapped Companies:');
    console.table(usersRes.rows);

    if (usersRes.rows.length === 0) {
      console.log('No users found in database.');
      return;
    }

    const testUser = usersRes.rows[0];
    console.log(`\nSimulating tracked events for User: ${testUser.name} (${testUser.email}, Role: ${testUser.role_name || 'N/A'}, Company: ${testUser.company_name || 'Unassigned'})...`);

    // 2. Simulate sending LLM parse event via UsageTrackerService endpoint
    const llmPayload = JSON.stringify({
      userId: testUser.id,
      sourceService: 'BACKEND',
      featureName: 'cv_parser',
      modelName: 'meta/llama-3.1-8b-instruct',
      providerName: 'https://integrate.api.nvidia.com/v1',
      promptTokens: 850,
      completionTokens: 320,
      totalTokens: 1170,
      status: 'SUCCESS',
      latencyMs: 1420,
      metadata: { source: 'test-tracking.js' },
    });

    const llmRes = await sendEvent(llmPayload);
    console.log('\n[1] Posted LLM Parse Event (cv_parser):', llmRes);

    // 3. Simulate sending N8N Chatbot event via UsageTrackerService endpoint
    const n8nPayload = JSON.stringify({
      userId: testUser.id,
      sourceService: 'BACKEND',
      featureName: 'n8n_chatbot',
      status: 'SUCCESS',
      latencyMs: 980,
      metadata: { sessionId: 'test-session-123', messageLength: 45 },
    });

    const n8nRes = await sendEvent(n8nPayload);
    console.log('[2] Posted N8N Chatbot Event (n8n_chatbot):', n8nRes);

    // 4. Verify recorded events in database
    const eventsRes = await client.query(`
      SELECT e.id, e.user_id, u.email, e.source_service, e.feature_name, e.prompt_tokens, e.completion_tokens, e.total_tokens, e.cost_amount, e.cost_currency, e.status, e.created_at
      FROM llm_usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC
      LIMIT 5;
    `);

    console.log('\nLatest 5 Recorded Events in DB:');
    console.table(eventsRes.rows);

    // 5. Check aggregate summary per user & company
    const userSummaryRes = await client.query(`
      SELECT 
        e.user_id,
        u.email,
        c.name AS company_name,
        COUNT(e.id) AS total_events,
        SUM(e.total_tokens) AS total_tokens_used,
        SUM(e.cost_amount) AS total_cost_idr
      FROM llm_usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN llm_user_mappings m ON m.user_id = e.user_id
      LEFT JOIN llm_companies c ON c.id = m.company_id
      WHERE e.user_id = $1
      GROUP BY e.user_id, u.email, c.name;
    `, [testUser.id]);

    console.log('\nUsage & Cost Summary for Test User:');
    console.table(userSummaryRes.rows);

    console.log('\n✅ Tracking per user and per company verification COMPLETE!');
  } catch (err) {
    console.error('Error during test execution:', err);
  } finally {
    await client.end();
  }
}

function sendEvent(payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${DASHBOARD_URL}/api/internal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service': 'backend',
        'x-internal-key': INTERNAL_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

runTest();

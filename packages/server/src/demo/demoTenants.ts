// Demo tenants seeded by init.sql (keys stored there only as SHA-256 hashes).
// The raw keys live here so the traffic generator can call the public API
// exactly like a real client would. Demo-only: the /admin/demo routes are
// disabled unless DEMO_MODE=true.
export const DEMO_TENANTS = {
  acme: { name: 'Acme Corp', apiKey: 'demo-key-acme' },
  globex: { name: 'Globex', apiKey: 'demo-key-globex' },
  initech: { name: 'Initech (noisy)', apiKey: 'demo-key-initech' },
} as const;

export type DemoTenantId = keyof typeof DEMO_TENANTS;

export const SAMPLE_PROMPTS = [
  'Summarise this support ticket in one sentence: customer cannot reset password.',
  'Classify the sentiment of: "The new dashboard is fantastic, but exports are slow."',
  'Write a product description for a waterproof hiking backpack.',
  'Translate to French: "Your order has shipped and will arrive Tuesday."',
  'Extract the city and date from: "Meet me in Berlin on 12 March."',
  'Suggest three subject lines for a spring sale newsletter.',
  'Explain what an API rate limit is to a non-technical user.',
  'Rewrite more politely: "Send me the report now."',
];

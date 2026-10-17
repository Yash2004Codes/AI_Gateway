// npm run seed:demo — populate ~24h of request history for the dashboard
import 'dotenv/config';
import { seedHistory } from '../demo/seedHistory';
import { closePool } from '../db/pool';

seedHistory()
  .then((r) => console.log(`Seeded ${r.requests} requests and ${r.ledger} ledger rows`))
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());

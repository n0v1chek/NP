require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function migrate() {
  const dataFile = path.join(__dirname, 'data.json');

  if (!fs.existsSync(dataFile)) {
    console.log('No data.json found, skipping migration');
    return;
  }

  try {
    const jsonData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    console.log('Starting migration from data.json...');
    console.log(`Found: ${Object.keys(jsonData.companies || {}).length} companies`);
    console.log(`Found: ${Object.keys(jsonData.users || {}).length} users`);
    console.log(`Found: ${(jsonData.transactions || []).length} transactions`);
    console.log(`Found: ${(jsonData.generations || []).length} generations`);
    console.log(`Found: ${(jsonData.accessRequests || []).length} access requests`);

    await db.migrateFromJson(jsonData);

    // Переименовываем старый файл
    const backupFile = path.join(__dirname, 'data.json.backup');
    fs.renameSync(dataFile, backupFile);
    console.log(`Old data.json renamed to data.json.backup`);

  } catch (e) {
    console.error('Migration error:', e);
  } finally {
    await db.pool.end();
  }
}

migrate();

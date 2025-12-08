const { Pool } = require('pg');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'potolki_bot',
  user: 'aichat_user',
  password: process.env.DB_PASSWORD || 'p2l/n+T4vCqChq9E9FD0QE4rHYpI/Xyd',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Проверка подключения
pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// ============ КОМПАНИИ ============

async function getCompanies() {
  const result = await pool.query('SELECT * FROM companies ORDER BY name');
  return result.rows.reduce((acc, c) => { acc[c.id] = c; return acc; }, {});
}

async function getCompany(id) {
  const result = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function addCompany(name) {
  const result = await pool.query(
    'INSERT INTO companies (name) VALUES ($1) RETURNING *',
    [name]
  );
  return result.rows[0];
}

async function updateCompany(id, updates) {
  if (updates.name) {
    await pool.query('UPDATE companies SET name = $1 WHERE id = $2', [updates.name, id]);
  }
}

async function deleteCompany(id) {
  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
}

// ============ ПОЛЬЗОВАТЕЛИ ============

async function getAllUsers() {
  const result = await pool.query('SELECT * FROM users');
  return result.rows.reduce((acc, u) => { acc[u.id] = u; return acc; }, {});
}

async function getUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function createUser(userId, companyId, name) {
  const result = await pool.query(
    'INSERT INTO users (id, company_id, name, balance) VALUES ($1, $2, $3, 0) RETURNING *',
    [userId, companyId, name]
  );
  return result.rows[0];
}

async function updateUser(userId, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;

  if (updates.balance !== undefined) {
    setClauses.push(`balance = $${i++}`);
    values.push(updates.balance);
  }
  if (updates.blocked !== undefined) {
    setClauses.push(`blocked = $${i++}`);
    values.push(updates.blocked);
  }
  if (updates.name !== undefined) {
    setClauses.push(`name = $${i++}`);
    values.push(updates.name);
  }
  if (updates.companyId !== undefined) {
    setClauses.push(`company_id = $${i++}`);
    values.push(updates.companyId);
  }

  if (setClauses.length > 0) {
    values.push(userId);
    await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${i}`,
      values
    );
  }
}

async function deleteUser(userId) {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

async function getCompanyUsers(companyId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE company_id = $1 ORDER BY name',
    [companyId]
  );
  return result.rows;
}

async function getLowBalanceUsers(threshold = 150) {
  const result = await pool.query(
    'SELECT u.*, c.name as company_name FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.balance <= $1 AND u.blocked = false ORDER BY u.balance ASC',
    [threshold]
  );
  return result.rows;
}

// ============ ТРАНЗАКЦИИ ============

async function addTransaction(userId, amount, type, description) {
  const result = await pool.query(
    'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, amount, type, description]
  );
  return result.rows[0];
}

async function getAllTransactions() {
  const result = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC');
  return result.rows;
}

async function getUserTransactions(userId) {
  const result = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

// ============ ГЕНЕРАЦИИ ============

async function addGeneration(userId, config, resultUrl = null) {
  const result = await pool.query(
    'INSERT INTO generations (user_id, config, result_url) VALUES ($1, $2, $3) RETURNING *',
    [userId, JSON.stringify(config), resultUrl]
  );
  return result.rows[0];
}

async function getAllGenerations() {
  const result = await pool.query('SELECT * FROM generations ORDER BY created_at DESC');
  return result.rows;
}

async function getUserGenerations(userId) {
  const result = await pool.query(
    'SELECT * FROM generations WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

// ============ ЗАЯВКИ НА ДОСТУП ============

async function getAccessRequests() {
  const result = await pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
  return result.rows;
}

async function addAccessRequest(userId, username, firstName, lastName) {
  try {
    const result = await pool.query(
      'INSERT INTO access_requests (user_id, username, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, username, firstName, lastName]
    );
    return result.rows[0];
  } catch (e) {
    if (e.code === '23505') return null; // Duplicate
    throw e;
  }
}

async function deleteAccessRequest(requestId) {
  await pool.query('DELETE FROM access_requests WHERE id = $1', [requestId]);
}

async function getAccessRequestByUserId(userId) {
  const result = await pool.query('SELECT * FROM access_requests WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

// ============ ИЗБРАННОЕ ============

async function getFavorites(userId) {
  const result = await pool.query(
    'SELECT * FROM favorites WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

async function addFavorite(userId, name, config) {
  const result = await pool.query(
    'INSERT INTO favorites (user_id, name, config) VALUES ($1, $2, $3) RETURNING *',
    [userId, name, JSON.stringify(config)]
  );
  return result.rows[0];
}

async function deleteFavorite(favoriteId, userId) {
  await pool.query('DELETE FROM favorites WHERE id = $1 AND user_id = $2', [favoriteId, userId]);
}

async function getFavorite(favoriteId, userId) {
  const result = await pool.query(
    'SELECT * FROM favorites WHERE id = $1 AND user_id = $2',
    [favoriteId, userId]
  );
  return result.rows[0] || null;
}

// ============ СТАТИСТИКА ============

async function getStats() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) as users_count,
      (SELECT COUNT(*) FROM users WHERE blocked = true) as blocked_count,
      (SELECT COUNT(*) FROM companies) as companies_count,
      (SELECT COALESCE(SUM(balance), 0) FROM users) as total_balance,
      (SELECT COUNT(*) FROM generations) as generations_count,
      (SELECT COUNT(*) FROM access_requests) as requests_count,
      (SELECT COUNT(*) FROM generations WHERE created_at::date = CURRENT_DATE) as today_generations,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'topup' AND created_at::date = CURRENT_DATE) as today_topups
  `);
  return result.rows[0];
}

// ============ МИГРАЦИЯ ИЗ JSON ============

async function migrateFromJson(jsonData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Компании
    for (const [id, company] of Object.entries(jsonData.companies || {})) {
      await client.query(
        'INSERT INTO companies (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [parseInt(id), company.name, company.createdAt || new Date()]
      );
    }

    // Пользователи
    for (const [id, user] of Object.entries(jsonData.users || {})) {
      await client.query(
        'INSERT INTO users (id, company_id, name, balance, blocked, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        [parseInt(id), user.companyId ? parseInt(user.companyId) : null, user.name, user.balance || 0, user.blocked || false, user.createdAt || new Date()]
      );
    }

    // Транзакции
    for (const tx of jsonData.transactions || []) {
      await client.query(
        'INSERT INTO transactions (user_id, amount, type, description, created_at) VALUES ($1, $2, $3, $4, $5)',
        [tx.userId, tx.amount, tx.type, tx.description, tx.createdAt || new Date()]
      );
    }

    // Генерации (пропускаем если пользователя нет)
    for (const gen of jsonData.generations || []) {
      const userExists = await client.query('SELECT 1 FROM users WHERE id = $1', [gen.userId]);
      if (userExists.rows.length > 0) {
        await client.query(
          'INSERT INTO generations (user_id, config, result_url, cost, created_at) VALUES ($1, $2, $3, $4, $5)',
          [gen.userId, JSON.stringify(gen.config), gen.resultUrl || null, gen.cost || 75, gen.createdAt || new Date()]
        );
      } else {
        console.log(`Skipping generation for non-existent user ${gen.userId}`);
      }
    }

    // Заявки
    for (const req of jsonData.accessRequests || []) {
      await client.query(
        'INSERT INTO access_requests (user_id, username, first_name, last_name, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO NOTHING',
        [req.userId, req.username, req.firstName, req.lastName, req.createdAt || new Date()]
      );
    }

    // Сбрасываем последовательности
    await client.query("SELECT setval('companies_id_seq', COALESCE((SELECT MAX(id) FROM companies), 1))");
    await client.query("SELECT setval('transactions_id_seq', COALESCE((SELECT MAX(id) FROM transactions), 1))");
    await client.query("SELECT setval('generations_id_seq', COALESCE((SELECT MAX(id) FROM generations), 1))");
    await client.query("SELECT setval('access_requests_id_seq', COALESCE((SELECT MAX(id) FROM access_requests), 1))");

    await client.query('COMMIT');
    console.log('Migration completed successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  getCompanies,
  getCompany,
  addCompany,
  updateCompany,
  deleteCompany,
  getAllUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getCompanyUsers,
  getLowBalanceUsers,
  addTransaction,
  getAllTransactions,
  getUserTransactions,
  addGeneration,
  getAllGenerations,
  getUserGenerations,
  getAccessRequests,
  addAccessRequest,
  deleteAccessRequest,
  getAccessRequestByUserId,
  getFavorites,
  addFavorite,
  deleteFavorite,
  getFavorite,
  getStats,
  migrateFromJson
};

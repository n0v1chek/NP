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

async function addGeneration(userId, config, resultUrl = null, costUsd = null) {
  const result = await pool.query(
    'INSERT INTO generations (user_id, config, result_url, cost_usd) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, JSON.stringify(config), resultUrl, costUsd]
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

// ============ СТАТИСТИКА РАСХОДОВ REPLICATE ============

async function getCostStats(days = 30) {
  // Внутренний курс компании для пополнения в доллары
  const CBR_RATE = 140.0;

  const result = await pool.query(`
    SELECT
      COUNT(*) as total_generations,
      COALESCE(SUM(cost), 0) as total_revenue_rub,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd,
      COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) as today_generations,
      COALESCE(SUM(cost) FILTER (WHERE created_at::date = CURRENT_DATE), 0) as today_revenue_rub,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at::date = CURRENT_DATE), 0) as today_cost_usd
    FROM generations
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
  `, [days]);

  const row = result.rows[0];

  const totalRevenueRub = parseFloat(row.total_revenue_rub) || 0;
  const totalCostUsd = parseFloat(row.total_cost_usd) || 0;
  const totalCostRub = totalCostUsd * CBR_RATE;
  const totalProfitRub = totalRevenueRub - totalCostRub;
  const marginPercent = totalCostRub > 0 ? ((totalRevenueRub - totalCostRub) / totalCostRub * 100) : 0;

  const todayRevenueRub = parseFloat(row.today_revenue_rub) || 0;
  const todayCostUsd = parseFloat(row.today_cost_usd) || 0;
  const todayCostRub = todayCostUsd * CBR_RATE;
  const todayProfitRub = todayRevenueRub - todayCostRub;

  return {
    period_days: days,
    cbr_rate: CBR_RATE,
    total: {
      generations: parseInt(row.total_generations) || 0,
      revenue_rub: Math.round(totalRevenueRub * 100) / 100,
      cost_usd: Math.round(totalCostUsd * 10000) / 10000,
      cost_rub: Math.round(totalCostRub * 100) / 100,
      profit_rub: Math.round(totalProfitRub * 100) / 100,
      margin_percent: Math.round(marginPercent * 10) / 10
    },
    today: {
      generations: parseInt(row.today_generations) || 0,
      revenue_rub: Math.round(todayRevenueRub * 100) / 100,
      cost_usd: Math.round(todayCostUsd * 10000) / 10000,
      cost_rub: Math.round(todayCostRub * 100) / 100,
      profit_rub: Math.round(todayProfitRub * 100) / 100
    }
  };
}

async function getDailyCostStats(days = 30) {
  // Внутренний курс компании для пополнения в доллары
  const CBR_RATE = 140.0;

  const result = await pool.query(`
    SELECT
      DATE(created_at) as date,
      COUNT(*) as generations,
      COALESCE(SUM(cost), 0) as revenue_rub,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM generations
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [days]);

  return result.rows.map(row => {
    const revenueRub = parseFloat(row.revenue_rub) || 0;
    const costUsd = parseFloat(row.cost_usd) || 0;
    const costRub = costUsd * CBR_RATE;
    const profitRub = revenueRub - costRub;
    const margin = costRub > 0 ? ((revenueRub - costRub) / costRub * 100) : 0;

    return {
      date: row.date,
      generations: parseInt(row.generations) || 0,
      revenue_rub: Math.round(revenueRub * 100) / 100,
      cost_usd: Math.round(costUsd * 10000) / 10000,
      cost_rub: Math.round(costRub * 100) / 100,
      profit_rub: Math.round(profitRub * 100) / 100,
      margin_percent: Math.round(margin * 10) / 10
    };
  });
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

// ============ РЕГИСТРАЦИЯ (v2.0) ============

async function registerIndividual(userId, name, username, phone = null) {
  const result = await pool.query(
    `INSERT INTO users (id, name, username, phone, user_type, balance)
     VALUES ($1, $2, $3, $4, 'individual', 0)
     ON CONFLICT (id) DO UPDATE SET name = $2, username = $3, phone = COALESCE($4, users.phone), user_type = 'individual'
     RETURNING *`,
    [userId, name, username, phone]
  );
  return result.rows[0];
}

async function registerCompanyOwner(userId, name, username, companyName, inn = null, description = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Создаём компанию
    // Генерируем уникальный invite_code (без похожих символов 0/O, 1/I)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const inviteCode = Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    
    const companyResult = await client.query(
      `INSERT INTO companies (name, owner_id, inn, description, shared_balance, invite_code)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
      [companyName, userId, inn, description, inviteCode]
    );
    const company = companyResult.rows[0];

    // Создаём/обновляем пользователя как владельца
    const userResult = await client.query(
      `INSERT INTO users (id, name, username, company_id, user_type, balance)
       VALUES ($1, $2, $3, $4, 'company_owner', 0)
       ON CONFLICT (id) DO UPDATE SET
         name = $2, username = $3, company_id = $4, user_type = 'company_owner'
       RETURNING *`,
      [userId, name, username, company.id]
    );

    await client.query('COMMIT');
    return { user: userResult.rows[0], company };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============ ПРИГЛАШЕНИЯ В КОМПАНИЮ ============

async function inviteToCompany(companyId, invitedUserId, invitedBy) {
  try {
    const result = await pool.query(
      `INSERT INTO company_invites (company_id, invited_user_id, invited_by, status)
       VALUES ($1, $2, $3, 'pending') RETURNING *`,
      [companyId, invitedUserId, invitedBy]
    );
    return result.rows[0];
  } catch (e) {
    if (e.code === '23505') return null; // Duplicate
    throw e;
  }
}

async function getPendingInvites(userId) {
  const result = await pool.query(
    `SELECT ci.*, c.name as company_name, c.owner_id
     FROM company_invites ci
     JOIN companies c ON ci.company_id = c.id
     WHERE ci.invited_user_id = $1 AND ci.status = 'pending'
     ORDER BY ci.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getCompanyInvites(companyId) {
  const result = await pool.query(
    `SELECT ci.*, u.name as invited_name, u.username as invited_username
     FROM company_invites ci
     LEFT JOIN users u ON ci.invited_user_id = u.id
     WHERE ci.company_id = $1 AND ci.status = 'pending'
     ORDER BY ci.created_at DESC`,
    [companyId]
  );
  return result.rows;
}

async function acceptInvite(inviteId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Получаем приглашение
    const inviteResult = await client.query(
      `SELECT * FROM company_invites WHERE id = $1 AND invited_user_id = $2 AND status = 'pending'`,
      [inviteId, userId]
    );
    if (inviteResult.rows.length === 0) {
      throw new Error('Приглашение не найдено');
    }
    const invite = inviteResult.rows[0];

    // Обновляем статус приглашения
    await client.query(
      `UPDATE company_invites SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [inviteId]
    );

    // Обновляем пользователя
    await client.query(
      `UPDATE users SET company_id = $1, user_type = 'employee' WHERE id = $2`,
      [invite.company_id, userId]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function declineInvite(inviteId, userId) {
  const result = await pool.query(
    `UPDATE company_invites SET status = 'declined', updated_at = NOW()
     WHERE id = $1 AND invited_user_id = $2 AND status = 'pending' RETURNING *`,
    [inviteId, userId]
  );
  return result.rows[0];
}

async function cancelInvite(inviteId, companyId) {
  const result = await pool.query(
    `UPDATE company_invites SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING *`,
    [inviteId, companyId]
  );
  return result.rows[0];
}

// ============ ПЕРЕДАЧА ПРАВ ВЛАДЕЛЬЦА ============

async function requestOwnershipTransfer(companyId, fromUserId, toUserId) {
  // Проверяем что toUserId - сотрудник этой компании
  const userCheck = await pool.query(
    `SELECT * FROM users WHERE id = $1 AND company_id = $2`,
    [toUserId, companyId]
  );
  if (userCheck.rows.length === 0) {
    throw new Error('Пользователь не является сотрудником компании');
  }

  const result = await pool.query(
    `INSERT INTO ownership_transfers (company_id, from_user_id, to_user_id, status)
     VALUES ($1, $2, $3, 'pending') RETURNING *`,
    [companyId, fromUserId, toUserId]
  );
  return result.rows[0];
}

async function getPendingTransfer(userId) {
  const result = await pool.query(
    `SELECT ot.*, c.name as company_name, u.name as from_user_name
     FROM ownership_transfers ot
     JOIN companies c ON ot.company_id = c.id
     JOIN users u ON ot.from_user_id = u.id
     WHERE ot.to_user_id = $1 AND ot.status = 'pending'
     ORDER BY ot.created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0];
}

async function acceptOwnershipTransfer(transferId, toUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Получаем запрос на передачу
    const transferResult = await client.query(
      `SELECT * FROM ownership_transfers WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [transferId, toUserId]
    );
    if (transferResult.rows.length === 0) {
      throw new Error('Запрос не найден');
    }
    const transfer = transferResult.rows[0];

    // Обновляем статус запроса
    await client.query(
      `UPDATE ownership_transfers SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [transferId]
    );

    // Меняем владельца компании
    await client.query(
      `UPDATE companies SET owner_id = $1 WHERE id = $2`,
      [toUserId, transfer.company_id]
    );

    // Меняем роли пользователей
    await client.query(
      `UPDATE users SET user_type = 'employee' WHERE id = $1`,
      [transfer.from_user_id]
    );
    await client.query(
      `UPDATE users SET user_type = 'company_owner' WHERE id = $1`,
      [toUserId]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function declineOwnershipTransfer(transferId, toUserId) {
  const result = await pool.query(
    `UPDATE ownership_transfers SET status = 'declined', updated_at = NOW()
     WHERE id = $1 AND to_user_id = $2 AND status = 'pending' RETURNING *`,
    [transferId, toUserId]
  );
  return result.rows[0];
}

// ============ УДАЛЕНИЕ СОТРУДНИКА ИЗ КОМПАНИИ ============

async function removeFromCompany(userId, companyId) {
  const result = await pool.query(
    `UPDATE users SET company_id = NULL, user_type = 'individual'
     WHERE id = $1 AND company_id = $2 AND user_type = 'employee' RETURNING *`,
    [userId, companyId]
  );
  return result.rows[0];
}

async function leaveCompany(userId) {
  const result = await pool.query(
    `UPDATE users SET company_id = NULL, user_type = 'individual'
     WHERE id = $1 AND user_type = 'employee' RETURNING *`,
    [userId]
  );
  return result.rows[0];
}

// ============ ПЛАТЕЖИ YOOKASSA ============

async function createPayment(userId, amount, companyId = null, targetUserId = null, description = null) {
  const result = await pool.query(
    `INSERT INTO payments (user_id, amount, company_id, target_user_id, description, yookassa_status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [userId, amount, companyId, targetUserId, description]
  );
  return result.rows[0];
}

async function updatePaymentYookassa(paymentId, yookassaPaymentId, status, paymentMethod = null) {
  const result = await pool.query(
    `UPDATE payments SET
       yookassa_payment_id = $2,
       yookassa_status = $3::varchar,
       payment_method = $4,
       paid_at = CASE WHEN $3::varchar = 'succeeded' THEN NOW() ELSE paid_at END
     WHERE id = $1 RETURNING *`,
    [paymentId, yookassaPaymentId, status, paymentMethod]
  );
  return result.rows[0];
}

async function getPaymentByYookassaId(yookassaPaymentId) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE yookassa_payment_id = $1`,
    [yookassaPaymentId]
  );
  return result.rows[0];
}

async function processSuccessfulPayment(paymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Получаем платёж
    const paymentResult = await client.query(
      `SELECT * FROM payments WHERE id = $1 AND yookassa_status = 'succeeded'`,
      [paymentId]
    );
    if (paymentResult.rows.length === 0) {
      throw new Error('Платёж не найден или не оплачен');
    }
    const payment = paymentResult.rows[0];

    if (payment.company_id && !payment.target_user_id) {
      // Пополнение общего счёта компании
      await client.query(
        `UPDATE companies SET shared_balance = shared_balance + $1 WHERE id = $2`,
        [payment.amount, payment.company_id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'topup', 'Пополнение общего счёта компании')`,
        [payment.user_id, payment.amount]
      );
    } else if (payment.company_id && payment.target_user_id) {
      // Пополнение счёта конкретного сотрудника
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [payment.amount, payment.target_user_id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'topup', 'Пополнение от компании')`,
        [payment.target_user_id, payment.amount]
      );
    } else {
      // Пополнение личного счёта (частник)
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [payment.amount, payment.user_id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'topup', 'Пополнение баланса')`,
        [payment.user_id, payment.amount]
      );
    }

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getUserPayments(userId, limit = 20) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// ============ РАСПРЕДЕЛЕНИЕ БАЛАНСА ============

async function distributeBalance(companyId, distributedBy, distribution) {
  // distribution = { userId: amount, ... }
  // Проверяем что суммы кратны 75
  const amounts = Object.values(distribution);
  for (const amount of amounts) {
    if (amount % 75 !== 0) {
      throw new Error('Суммы должны быть кратны 75');
    }
  }

  const totalAmount = amounts.reduce((a, b) => a + b, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверяем баланс компании
    const companyResult = await client.query(
      `SELECT shared_balance FROM companies WHERE id = $1 FOR UPDATE`,
      [companyId]
    );
    if (companyResult.rows.length === 0) {
      throw new Error('Компания не найдена');
    }
    if (companyResult.rows[0].shared_balance < totalAmount) {
      throw new Error('Недостаточно средств на общем счёте');
    }

    // Списываем с общего счёта
    await client.query(
      `UPDATE companies SET shared_balance = shared_balance - $1 WHERE id = $2`,
      [totalAmount, companyId]
    );

    // Начисляем каждому сотруднику
    for (const [userId, amount] of Object.entries(distribution)) {
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE id = $2 AND company_id = $3`,
        [amount, parseInt(userId), companyId]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'distribution', 'Распределение от компании')`,
        [parseInt(userId), amount]
      );
    }

    // Сохраняем историю распределения
    await client.query(
      `INSERT INTO balance_distributions (company_id, distributed_by, amount, distribution)
       VALUES ($1, $2, $3, $4)`,
      [companyId, distributedBy, totalAmount, JSON.stringify(distribution)]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function distributeEvenly(companyId, distributedBy, totalAmount) {
  // Получаем список сотрудников
  const employeesResult = await pool.query(
    `SELECT id FROM users WHERE company_id = $1`,
    [companyId]
  );
  const employees = employeesResult.rows;

  if (employees.length === 0) {
    throw new Error('В компании нет сотрудников');
  }

  // Делим поровну, округляя до кратного 75
  const perPerson = Math.floor(totalAmount / employees.length / 75) * 75;
  if (perPerson < 75) {
    throw new Error('Сумма слишком мала для распределения');
  }

  const distribution = {};
  for (const emp of employees) {
    distribution[emp.id] = perPerson;
  }

  return distributeBalance(companyId, distributedBy, distribution);
}

// ============ СТАТИСТИКА ДЛЯ КОМПАНИЙ ============

async function getCompanyStats(companyId) {
  const result = await pool.query(`
    SELECT
      c.id, c.name, c.shared_balance, c.owner_id,
      (SELECT COUNT(*) FROM users WHERE company_id = $1) as employees_count,
      (SELECT COALESCE(SUM(balance), 0) FROM users WHERE company_id = $1) as total_employee_balance,
      (SELECT COUNT(*) FROM generations g JOIN users u ON g.user_id = u.id WHERE u.company_id = $1) as total_generations,
      (SELECT COUNT(*) FROM generations g JOIN users u ON g.user_id = u.id WHERE u.company_id = $1 AND g.created_at::date = CURRENT_DATE) as today_generations
    FROM companies c WHERE c.id = $1
  `, [companyId]);
  return result.rows[0];
}

async function getCompanyEmployeeStats(companyId) {
  const result = await pool.query(`
    SELECT
      u.id, u.name, u.username, u.balance, u.user_type,
      (SELECT COUNT(*) FROM generations WHERE user_id = u.id) as total_generations,
      (SELECT COUNT(*) FROM generations WHERE user_id = u.id AND created_at::date = CURRENT_DATE) as today_generations,
      (SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions WHERE user_id = u.id AND type = 'generation') as total_spent
    FROM users u
    WHERE u.company_id = $1
    ORDER BY u.user_type DESC, u.name
  `, [companyId]);
  return result.rows;
}

async function getUserStats(userId) {
  const result = await pool.query(`
    SELECT
      u.*,
      c.name as company_name, c.shared_balance as company_balance,
      (SELECT COUNT(*) FROM generations WHERE user_id = $1) as total_generations,
      (SELECT COUNT(*) FROM generations WHERE user_id = $1 AND created_at::date = CURRENT_DATE) as today_generations,
      (SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions WHERE user_id = $1 AND type = 'generation') as total_spent,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = $1 AND type = 'topup') as total_topups
    FROM users u
    LEFT JOIN companies c ON u.company_id = c.id
    WHERE u.id = $1
  `, [userId]);
  return result.rows[0];
}

async function getCompanyByOwner(ownerId) {
  const result = await pool.query(
    `SELECT * FROM companies WHERE owner_id = $1`,
    [ownerId]
  );
  return result.rows[0];
}

// ============ PENDING GENERATIONS (для webhooks) ============

async function createPendingGeneration(predictionId, userId, chatId, statusMessageId, config, photo) {
  const result = await pool.query(
    `INSERT INTO pending_generations (prediction_id, user_id, chat_id, status_message_id, config, photo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [predictionId, userId, chatId, statusMessageId, JSON.stringify(config), photo]
  );
  return result.rows[0];
}

async function getPendingGeneration(predictionId) {
  const result = await pool.query(
    `SELECT * FROM pending_generations WHERE prediction_id = $1`,
    [predictionId]
  );
  return result.rows[0];
}

async function updatePendingGeneration(predictionId, status) {
  await pool.query(
    `UPDATE pending_generations SET status = $1 WHERE prediction_id = $2`,
    [status, predictionId]
  );
}

async function deletePendingGeneration(predictionId) {
  await pool.query(
    `DELETE FROM pending_generations WHERE prediction_id = $1`,
    [predictionId]
  );
}


// Получить компанию по invite_code
async function getCompanyByInviteCode(inviteCode) {
  const result = await pool.query(
    'SELECT * FROM companies WHERE UPPER(invite_code) = UPPER($1)',
    [inviteCode]
  );
  return result.rows[0];
}

// Регистрация сотрудника
async function registerEmployee(userId, name, username, companyId) {
  const result = await pool.query(
    `INSERT INTO users (id, name, username, company_id, user_type, balance)
     VALUES ($1, $2, $3, $4, 'employee', 0)
     ON CONFLICT (id) DO UPDATE SET
       name = $2, username = $3, company_id = $4, user_type = 'employee'
     RETURNING *`,
    [userId, name, username, companyId]
  );
  return result.rows[0];
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
  getCostStats,
  getDailyCostStats,
  migrateFromJson,
  // v2.0 - Компании и оплата
  registerIndividual,
  registerCompanyOwner,
  inviteToCompany,
  getPendingInvites,
  getCompanyInvites,
  acceptInvite,
  declineInvite,
  cancelInvite,
  requestOwnershipTransfer,
  getPendingTransfer,
  acceptOwnershipTransfer,
  declineOwnershipTransfer,
  removeFromCompany,
  leaveCompany,
  createPayment,
  updatePaymentYookassa,
  getPaymentByYookassaId,
  processSuccessfulPayment,
  getUserPayments,
  distributeBalance,
  distributeEvenly,
  getCompanyStats,
  getCompanyEmployeeStats,
  getUserStats,
  getCompanyByOwner,
  getCompanyByInviteCode,
  registerEmployee,
  // Pending generations (webhooks)
  createPendingGeneration,
  getPendingGeneration,
  updatePendingGeneration,
  deletePendingGeneration
};

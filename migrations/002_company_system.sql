-- Миграция: Система компаний, сотрудников и оплаты
-- potolki-bot v2.0

-- 1. Обновляем таблицу users
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type VARCHAR(20) DEFAULT 'individual';
-- user_type: 'individual' (частник), 'company_owner' (владелец компании), 'employee' (сотрудник)

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);

-- 2. Обновляем таблицу companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_id BIGINT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shared_balance INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS inn VARCHAR(12);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description TEXT;

-- Индекс для поиска компаний по владельцу
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner_id);

-- 3. Приглашения в компанию
CREATE TABLE IF NOT EXISTS company_invites (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invited_user_id BIGINT NOT NULL,
    invited_by BIGINT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, declined, cancelled
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, invited_user_id, status)
);

CREATE INDEX IF NOT EXISTS idx_invites_user ON company_invites(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_invites_company ON company_invites(company_id);

-- 4. Запросы на передачу прав владельца
CREATE TABLE IF NOT EXISTS ownership_transfers (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    from_user_id BIGINT NOT NULL,
    to_user_id BIGINT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, declined, cancelled
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transfers_to ON ownership_transfers(to_user_id);

-- 5. Платежи YooKassa
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL, -- кто платит
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, -- если пополнение компании
    target_user_id BIGINT, -- если на конкретного сотрудника (NULL = на общий счёт)
    amount INTEGER NOT NULL, -- сумма в рублях
    yookassa_payment_id VARCHAR(100),
    yookassa_status VARCHAR(50) DEFAULT 'pending', -- pending, waiting_for_capture, succeeded, canceled
    payment_method VARCHAR(50), -- bank_card, sbp, etc
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_yookassa ON payments(yookassa_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(yookassa_status);

-- 6. Распределение баланса (история)
CREATE TABLE IF NOT EXISTS balance_distributions (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    from_shared BOOLEAN DEFAULT true, -- из общего счёта или от владельца
    distributed_by BIGINT NOT NULL, -- кто распределил
    amount INTEGER NOT NULL, -- общая сумма
    distribution JSONB NOT NULL, -- {"user_id": amount, ...}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_distributions_company ON balance_distributions(company_id);

-- 7. Обновляем сиквенсы
SELECT setval('companies_id_seq', COALESCE((SELECT MAX(id) FROM companies), 1));

-- 8. Комментарии для документации
COMMENT ON COLUMN users.user_type IS 'individual=частник, company_owner=владелец компании, employee=сотрудник';
COMMENT ON COLUMN companies.shared_balance IS 'Общий счёт компании в рублях';
COMMENT ON COLUMN payments.amount IS 'Сумма платежа в рублях';
COMMENT ON TABLE balance_distributions IS 'История распределения средств между сотрудниками';

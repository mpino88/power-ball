-- src/infrastructure/database/02-schema.sql
-- Fase 2: Manejo de Usuarios, Suscripciones, Estrategias y Referidos

CREATE TABLE IF NOT EXISTS plans (
  id VARCHAR(50) PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  description TEXT,
  price VARCHAR(50),
  menu_ids TEXT,
  price_1m VARCHAR(50),
  price_3m VARCHAR(50),
  price_6m VARCHAR(50),
  price_9m VARCHAR(50),
  price_1a VARCHAR(50),
  auto_approve BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username VARCHAR(255),
  phone VARCHAR(50),
  role VARCHAR(20) DEFAULT 'user',
  plan_id VARCHAR(50) REFERENCES plans(id) ON DELETE SET NULL,
  plan_status VARCHAR(20),
  pending_plan VARCHAR(100),
  plan_temporality VARCHAR(20),
  plan_expiry VARCHAR(20),
  trial_used BOOLEAN DEFAULT FALSE,
  referred_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_menus (
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  menu_id VARCHAR(100) NOT NULL,
  PRIMARY KEY (user_id, menu_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  rewarded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_strategies (
  id VARCHAR(50) PRIMARY KEY,
  titulo VARCHAR(255) NOT NULL,
  descripcion TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  price VARCHAR(50),
  visibility VARCHAR(20) DEFAULT 'private',
  subscribers INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  details TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS testing_config (
  key VARCHAR(50) PRIMARY KEY,
  value VARCHAR(255) NOT NULL
);

-- ============================================================
-- Ballbot — Schema Consolidado (Único archivo)
-- Ejecutar UNA VEZ en el VPS: psql $DATABASE_URL -f schema.sql
-- Orden: draws → plans → users → user_menus → referrals → resto
-- ============================================================

-- ── Fase 1: Sorteos ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS draws (
  date     VARCHAR(8)  NOT NULL,  -- MM/DD/YY
  game     VARCHAR(2)  NOT NULL,  -- 'p3' | 'p4'
  period   VARCHAR(1)  NOT NULL,  -- 'm' | 'e'
  numbers  VARCHAR(20) NOT NULL,  -- CSV de números
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date, game, period)
);
CREATE INDEX IF NOT EXISTS idx_draws_date ON draws (date DESC);
CREATE INDEX IF NOT EXISTS idx_draws_game  ON draws (game, date DESC);

-- ── Fase 2: Usuarios y Suscripciones ─────────────────────────

-- plans: catálogo en memoria (Sheet/hardcoded). La tabla almacena snapshot histórico.
-- plan_id en users es VARCHAR libre (sin FK) para no depender de este snapshot.
CREATE TABLE IF NOT EXISTS plans (
  id           VARCHAR(50)  PRIMARY KEY,
  title        VARCHAR(100) NOT NULL,
  description  TEXT,
  price        VARCHAR(50),
  menu_ids     TEXT,
  price_1m     VARCHAR(50),
  price_3m     VARCHAR(50),
  price_6m     VARCHAR(50),
  price_9m     VARCHAR(50),
  price_1a     VARCHAR(50),
  auto_approve BOOLEAN DEFAULT FALSE,
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id               BIGINT       PRIMARY KEY,
  username         VARCHAR(255),
  phone            VARCHAR(50),
  role             VARCHAR(20)  DEFAULT 'user',
  -- plan_id es referencia lógica (string), sin FK para no bloquear si plans está vacío
  plan_id          VARCHAR(50),
  plan_status      VARCHAR(20),
  pending_plan     VARCHAR(100),
  plan_temporality VARCHAR(20),
  plan_expiry      VARCHAR(20),
  trial_used       BOOLEAN      DEFAULT FALSE,
  referred_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índices críticos para queries frecuentes
CREATE INDEX IF NOT EXISTS idx_users_plan_status  ON users (plan_status);
CREATE INDEX IF NOT EXISTS idx_users_referred_by  ON users (referred_by);

CREATE TABLE IF NOT EXISTS user_menus (
  user_id  BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_id  VARCHAR(100) NOT NULL,
  PRIMARY KEY (user_id, menu_id)
);
CREATE INDEX IF NOT EXISTS idx_user_menus_user ON user_menus (user_id);

CREATE TABLE IF NOT EXISTS referrals (
  id          SERIAL   PRIMARY KEY,
  referrer_id BIGINT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id BIGINT   NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  rewarded    BOOLEAN  DEFAULT FALSE,
  rewarded_at TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- Índice crítico: se accede por referred_id + rewarded en CADA aprobación de plan
CREATE INDEX IF NOT EXISTS idx_referrals_referred  ON referrals (referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_rewarded  ON referrals (rewarded) WHERE rewarded = FALSE;

CREATE TABLE IF NOT EXISTS custom_strategies (
  id           VARCHAR(50)  PRIMARY KEY,
  titulo       VARCHAR(255) NOT NULL,
  descripcion  TEXT,
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  price        VARCHAR(50),
  visibility   VARCHAR(20)  DEFAULT 'private',
  subscribers  INTEGER      DEFAULT 0,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_strategies_visibility ON custom_strategies (visibility);

CREATE TABLE IF NOT EXISTS suggestions (
  id         SERIAL  PRIMARY KEY,
  user_id    BIGINT  REFERENCES users(id) ON DELETE SET NULL,
  text       TEXT    NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id        SERIAL  PRIMARY KEY,
  text      TEXT    NOT NULL,
  timestamp BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id      SERIAL       PRIMARY KEY,
  name    VARCHAR(100) NOT NULL,
  details TEXT         NOT NULL
);

CREATE TABLE IF NOT EXISTS testing_config (
  key   VARCHAR(50)  PRIMARY KEY,
  value VARCHAR(255) NOT NULL
);

-- ── Fase 3: Leads & Strategy Requests ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leads (
  id           SERIAL       PRIMARY KEY,
  user_id      BIGINT       NOT NULL,
  nombre       VARCHAR(255) DEFAULT '',
  telefono     VARCHAR(50)  DEFAULT '',
  plan         VARCHAR(100) DEFAULT '',
  temporality  VARCHAR(20)  DEFAULT '',
  fecha        VARCHAR(50)  DEFAULT '',
  status       VARCHAR(30)  DEFAULT 'trial_active',
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads (user_id);

CREATE TABLE IF NOT EXISTS strategy_requests (
  id           SERIAL       PRIMARY KEY,
  user_id      BIGINT       NOT NULL,
  menu_id      VARCHAR(100) NOT NULL,
  requested_at BIGINT       NOT NULL,
  UNIQUE(user_id, menu_id)
);
CREATE INDEX IF NOT EXISTS idx_strategy_requests_user ON strategy_requests (user_id);

-- ── Patch: suggestions — añadir campos extra si no existen ───────────────────
-- (Ejecutar solo una vez; IF NOT EXISTS es idempotente en PG 9.6+)
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS nombre   VARCHAR(255) DEFAULT '';
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS telefono VARCHAR(50)  DEFAULT '';
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS fecha    VARCHAR(50)  DEFAULT '';

-- ── Fase 4: Pending Interactions — Estado de sesión persistente ──────────────
-- Reemplaza los Maps en-memoria (pendingPlanRequest, pendingRenewal) de middleware.ts
-- para sobrevivir reinicios del proceso en Render.
-- TTL: 30 minutos. El bot limpia rows expirados en el arranque.
CREATE TABLE IF NOT EXISTS pending_interactions (
  user_id      BIGINT       PRIMARY KEY,
  type         VARCHAR(20)  NOT NULL,  -- 'plan_request' | 'plan_renewal'
  plan_id      VARCHAR(50)  NOT NULL,
  plan_name    VARCHAR(100) NOT NULL,
  temporality  VARCHAR(20)  NOT NULL,
  expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_interactions_expires ON pending_interactions (expires_at);
-- Limpieza de rows expirados (ejecutar al arranque del bot)
-- DELETE FROM pending_interactions WHERE expires_at < NOW();

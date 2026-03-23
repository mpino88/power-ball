-- src/infrastructure/database/01-schema.sql
-- Fase 1: Tabla de Draws (Sorteos)

CREATE TABLE IF NOT EXISTS draws (
  date VARCHAR(8) NOT NULL, -- Format MM/DD/YY
  game VARCHAR(2) NOT NULL, -- "p3" or "p4"
  period VARCHAR(1) NOT NULL, -- "m" or "e"
  numbers VARCHAR(20) NOT NULL, -- Comma-separated
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date, game, period)
);

-- Indice para facilitar consultas por fechas recientes
CREATE INDEX IF NOT EXISTS idx_draws_date ON draws (date DESC);

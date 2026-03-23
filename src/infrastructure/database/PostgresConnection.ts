import pg from "pg";

let pool: pg.Pool | null = null;

export function getDbPool(): pg.Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL no está definido");
    }
    
    // SSL SOLO si se activa explícitamente con DATABASE_SSL=true.
    // En Docker interno (host 'db'), NUNCA habilitar SSL — el contenedor PG no lo tiene configurado.
    // Para proveedores externos (Neon, Supabase, RDS) sí puede ser necesario.
    const useSSL = process.env.DATABASE_SSL === "true";
    
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: useSSL ? { rejectUnauthorized: false } : undefined
    });

    pool.on("error", (err) => {
      console.error("[PG Pool] Error inesperado en cliente idle:", err);
    });
  }
  return pool;
}

# Desplegar el bot gratis en Render

Render ofrece un **plan gratuito** para Web Services (sin tarjeta). El servicio se “duerme” tras ~15 min sin visitas; al escribir al bot, Telegram llama a tu URL y Render lo despierta (puede tardar 30–60 s la primera vez).

## 1. Subir el código a GitHub

Si aún no lo tienes en un repositorio:

```bash
cd /Users/maikelpino/free/power-ball
git init
git add .
git commit -m "Bot Telegram Power Ball"
# Crea un repo en github.com y luego:
git remote add origin https://github.com/TU_USUARIO/power-ball.git
git branch -M main
git push -u origin main
```

## 2. Crear el servicio en Render

1. Entra en **[render.com](https://render.com)** e inicia sesión (con GitHub).
2. **Dashboard** → **New +** → **Web Service**.
3. Conecta el repositorio **power-ball** (o el que uses). Si no aparece, **Connect account** y autoriza a Render para ver tus repos.
4. Configura:
   - **Name:** `power-ball-bot` (o el que quieras).
   - **Region:** el más cercano a ti.
   - **Branch:** `main`.
   - **Runtime:** `Node`.
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**.

5. En **Environment** añade:
   - `TELEGRAM_BOT_TOKEN` = el token que te dio @BotFather (ej: `123456:ABC-def...`).
   - Deja `WEBHOOK_URL` vacío por ahora.

6. Clic en **Create Web Service**. Render construye y despliega. Espera a que el estado sea **Live**.

## 3. Configurar el webhook

1. En el dashboard de Render, abre tu servicio. Arriba verás la URL, por ejemplo:
   `https://power-ball-bot.onrender.com`
2. En **Environment** del mismo servicio, añade:
   - **Key:** `WEBHOOK_URL`
   - **Value:** `https://power-ball-bot.onrender.com` (tu URL **sin** barra final).
3. Guarda. Render volverá a desplegar solo.

Con eso, al arrancar el bot registrará la URL de webhook en Telegram (`https://tu-url.onrender.com/webhook`) y empezará a recibir mensajes.

## 4. Probar el bot

Abre tu bot en Telegram (por nombre o `t.me/tu_bot`) y envía `/start`. Si acaba de despertar, la primera respuesta puede tardar unos segundos.

## Resumen de variables en Render

| Variable             | Valor                          |
|----------------------|--------------------------------|
| `TELEGRAM_BOT_TOKEN` | Token de @BotFather            |
| `WEBHOOK_URL`        | `https://tu-app.onrender.com`  |

## Si algo falla

- **Build error:** Revisa que `Build Command` sea exactamente `npm install && npm run build` y que el repo tenga `package.json` y `tsconfig.json`.
- **Bot no responde:** Comprueba que `WEBHOOK_URL` sea la URL pública del servicio (sin `/webhook` al final) y que el deploy esté en **Live**.
- **Primera respuesta lenta:** Normal en plan gratuito: el servicio estaba dormido; las siguientes serán rápidas mientras siga activo.

# Configuración paso a paso — Power Ball Bot

Sigue estos pasos en orden. Al final tendrás el bot funcionando con Telegram y la whitelist en Google Sheet.

---

## 1. Bot de Telegram

1. Abre Telegram y busca **@BotFather**.
2. Envía `/newbot`, pon un nombre y un username (ej: `power_ball_lottery_bot`).
3. BotFather te dará un **token** tipo: `7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

**Lo que necesitas anotar:**
- `TELEGRAM_BOT_TOKEN` = ese token completo.

---

## 2. Tu ID de usuario (dueño del bot)

1. En Telegram busca **@userinfobot**.
2. Envía cualquier mensaje; te responderá con tu **Id** (ej: `123456789`).

**Lo que necesitas anotar:**
- `BOT_OWNER_ID` = ese número (solo tú podrás agregar/quitar acceso y ver el menú Seguridad).

---

## 3. Google Sheet (cuenta de servicio)

### 3.1 Crear proyecto y activar API (si no lo has hecho)

1. Entra a [Google Cloud Console](https://console.cloud.google.com/).
2. Arriba elige o crea un **proyecto** (ej: "power-ball-bot").
3. Menú **APIs y servicios** → **Biblioteca**.
4. Busca **Google Sheets API** → **Habilitar**.
5. Menú **APIs y servicios** → **Credenciales** → **+ Crear credenciales** → **Cuenta de servicio**.
6. Nombre (ej: "bot-sheet"), **Crear y continuar** → rol opcional → **Listo**.
7. En la tabla, clic en la cuenta que creaste → pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → **JSON** → **Crear**. Se descargará un archivo `.json`.

**Lo que necesitas del JSON:**
- `client_email`: algo como `nombre@proyecto.iam.gserviceaccount.com`.
- `private_key`: el bloque completo entre `"-----BEGIN PRIVATE KEY-----"` y `"-----END PRIVATE KEY-----"` (incluyendo esas líneas).

**Opciones para las variables:**
- **Opción A:** usar el JSON completo como una sola variable (recomendado en Render).
- **Opción B:** usar solo `client_email` y `private_key` en dos variables.

### 3.2 Compartir la Sheet con la cuenta de servicio

1. Abre tu Google Sheet:  
   https://docs.google.com/spreadsheets/d/12zXYV7G9Pg3n3_Fu-pMG67z6xGUlSbuY-Yfa94bzrI8/
2. Clic en **Compartir**.
3. Pega el **client_email** de la cuenta de servicio (el del JSON).
4. Permiso: **Editor** → **Enviar**.

**No hace falta escribir nada en la hoja:** el bot creará la cabecera (`userId`, `est_grupos`, `est_individuales`) al iniciar.

---

## 4. Despliegue en Render (webhook)

1. Entra a [Render](https://render.com/) e inicia sesión (puedes usar GitHub).
2. **New** → **Web Service**.
3. Conecta el repo donde está este proyecto (o sube el código).
4. Configuración:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
5. En **Environment** añade estas variables (y rellena con lo que anotaste):

| Variable | Valor | Dónde lo sacas |
|----------|--------|----------------|
| `TELEGRAM_BOT_TOKEN` | (token del paso 1) | @BotFather |
| `WEBHOOK_URL` | `https://tu-app.onrender.com` | Lo dará Render al crear el servicio (sin barra final) |
| `BOT_OWNER_ID` | (tu ID del paso 2) | @userinfobot |
| `GOOGLE_SHEET_ID` | Ya está en el proyecto | `12zXYV7G9Pg3n3_Fu-pMG67z6xGUlSbuY-Yfa94bzrI8` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (ver abajo) | Archivo JSON del paso 3 |

**Para `GOOGLE_SERVICE_ACCOUNT_JSON`:**
- Abre el archivo JSON descargado.
- Cópialo **todo** en una sola línea (sin saltos de línea).
- En Render, pega ese texto como valor de `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Importante:** `WEBHOOK_URL` debe ser la URL pública de tu servicio en Render (ej: `https://power-ball-bot-xxxx.onrender.com`). Puedes dejarla vacía al crear el servicio, hacer **Deploy**, copiar la URL que te asigne Render y luego editar la variable `WEBHOOK_URL` con esa URL y guardar (se redeployará).

6. **Create Web Service** y espera al primer deploy.

---

## 5. Probar que todo funciona

1. En Telegram abre tu bot y envía `/start`.
2. Si configuraste `BOT_OWNER_ID`, solo tú (y quien agregues) podrán usar el bot.
3. Entra al menú **🔒 Seguridad** → **Agregar acceso** → escribe el ID de otro usuario (desde @userinfobot) → ese usuario ya tendrá acceso.
4. Revisa tu Google Sheet: deberían aparecer filas con `userId`, `est_grupos`, `est_individuales`.

---

## Resumen: qué info necesitas tener lista

| Dato | Dónde se usa |
|------|----------------|
| Token del bot | `TELEGRAM_BOT_TOKEN` (Render / .env) |
| Tu ID de Telegram | `BOT_OWNER_ID` (Render / .env) |
| URL pública del servicio (Render) | `WEBHOOK_URL` (Render) |
| ID de la Sheet | Ya configurado: `12zXYV7G9Pg3n3_Fu-pMG67z6xGUlSbuY-Yfa94bzrI8` |
| JSON de la cuenta de servicio (o email + private_key) | `GOOGLE_SERVICE_ACCOUNT_JSON` (o EMAIL + PRIVATE_KEY en Render / .env) |
| Email de la cuenta de servicio | Para compartir la Sheet en Google (Editor) |

---

## Ejecutar en local

1. Copia `.env.example` a `.env`.
2. Rellena en `.env` las mismas variables (token, tu ID, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`).
3. Para local no uses webhook: `npm run dev` y prueba con el bot en Telegram (Grammy en modo polling si no defines `WEBHOOK_URL` y `PORT` para webhook).

Si quieres, en el siguiente mensaje dime en qué paso estás (Telegram, Google, Render o local) y te digo exactamente qué poner en cada campo.

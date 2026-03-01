# Despliegue del bot en Render — paso a paso

Guía para publicar el bot de Telegram en [Render](https://render.com/) usando un **Web Service** y **webhook**. El bot escucha en una URL pública; Telegram envía ahí cada mensaje.

---

## Requisitos previos

- Cuenta en [Render](https://render.com/) (puedes registrarte con GitHub).
- Repositorio con este proyecto (GitHub, GitLab o similar), o código listo para conectar.
- Token del bot de Telegram (de @BotFather).
- Tu ID de Telegram (de @userinfobot).
- (Opcional) Google Sheet y cuenta de servicio para la whitelist.

---

## Paso 1: Entrar a Render y crear el servicio

1. Entra a **https://render.com** e inicia sesión.
2. En el panel, pulsa **New +** → **Web Service**.
3. Si te pide conectar un repo:
   - **Connect a repository** y autoriza Render para tu cuenta de GitHub/GitLab.
   - Elige el repositorio donde está el proyecto (por ejemplo `power-ball` o el nombre que tenga).
4. Si en el repo hay un **Blueprint** (`render.yaml`), Render puede detectarlo y pre-rellenar nombre, build y start. Si no, sigue el paso 2 manualmente.

---

## Paso 2: Configurar el servicio

En la pantalla de creación del Web Service:

| Campo | Valor |
|--------|--------|
| **Name** | `power-ball-bot` (o el nombre que quieras; será parte de la URL). |
| **Region** | El más cercano a ti (ej: Oregon). |
| **Branch** | La rama a desplegar (normalmente `main` o `master`). |
| **Runtime** | **Node**. |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |

- **Build Command:** instala dependencias y compila TypeScript (`tsc` genera la carpeta `dist/`).
- **Start Command:** ejecuta `node dist/bot.js`, que inicia el servidor HTTP y registra el webhook en Telegram.

No hace falta cambiar **Root Directory** si el proyecto está en la raíz del repo.

---

## Paso 3: Variables de entorno (Environment)

Antes de crear el servicio, en la sección **Environment** añade las variables. Algunas las rellenarás después del primer deploy (por ejemplo `WEBHOOK_URL`).

### Obligatorias para que el bot funcione

| Variable | Valor | Notas |
|----------|--------|--------|
| `TELEGRAM_BOT_TOKEN` | `123456789:AAH...` | Token que te dio @BotFather al crear el bot. |
| `WEBHOOK_URL` | `https://power-ball-bot-xxxx.onrender.com` | **La URL del servicio.** Tras el primer deploy, Render te dará algo como `https://power-ball-bot-xxxx.onrender.com`. Cópiala (sin `/` al final) y pégala aquí. Si la dejas vacía al inicio, después de crear el servicio la añades y guardas (Render redeployará). |

### Opcionales (whitelist y dueño)

| Variable | Valor | Notas |
|----------|--------|--------|
| `BOT_OWNER_ID` | `123456789` | Tu ID de Telegram (de @userinfobot). Solo tú tendrás menú Seguridad y podrás dar/quitar acceso. |
| `GOOGLE_SHEET_ID` | `12zXYV7G9Pg3n3_Fu-pMG67z6xGUlSbuY-Yfa94bzrI8` | ID de tu Google Sheet (ya viene en el proyecto). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account",...}` | Contenido completo del JSON de la cuenta de servicio, **en una sola línea**, sin saltos de línea. |
| `REQUEST_ACCESS_LINK` | (vacío o `t.me/mi_grupo`) | Si está vacío y hay `BOT_OWNER_ID`, el botón para no autorizados abre chat directo contigo. Si pones un enlace, el botón llevará ahí. |

Para **Secret Files** o variables largas (como el JSON), en Render se usan las variables de entorno normales: pega el JSON en una sola línea en `GOOGLE_SERVICE_ACCOUNT_JSON`.

---

## Paso 4: Crear el servicio y primer deploy

1. Pulsa **Create Web Service**.
2. Render hará el primer **Deploy**:
   - Clona el repo.
   - Ejecuta `npm install && npm run build`.
   - Ejecuta `npm start`.
3. En la pestaña **Logs** puedes ver la salida. Si todo va bien, verás que el servidor escucha en el puerto que asigne Render (ej: `PORT=10000`).
4. Arriba en el panel verás la **URL** del servicio, por ejemplo:
   - `https://power-ball-bot-xxxx.onrender.com`
5. Si no habías puesto `WEBHOOK_URL`:
   - Ve a **Environment** → edita `WEBHOOK_URL` → pega esa URL (sin `/` al final) → **Save Changes**.
   - Render hará un **redeploy** automático.

---

## Paso 5: Cómo funciona el webhook

1. Al arrancar, el bot hace:
   - `await bot.api.setWebhook(WEBHOOK_URL + "/webhook")`
   - Es decir, le dice a Telegram: “envía todos los updates a `https://tu-app.onrender.com/webhook`”.
2. Render mantiene el servicio activo y expuesto en esa URL.
3. Cada vez que alguien escribe al bot, Telegram hace un **POST** a `/webhook` con el mensaje. El servidor responde **200** enseguida y procesa el update en segundo plano (para no superar timeouts).

El plan gratuito de Render puede “dormir” el servicio tras inactividad; al recibir una petición tarda unos segundos en despertar. Es normal en el tier gratis.

---

## Paso 6: Comprobar que está desplegado

1. **Logs:** En Render → tu servicio → **Logs**. Deberías ver algo como que el servidor está escuchando y, si usas Sheet, `[user-config] Usando Google Sheet...`.
2. **Telegram:** Abre el bot y escribe `/start`. Si contestó, el webhook está bien configurado.
3. **Health:** Puedes abrir en el navegador `https://tu-app.onrender.com/` o `https://tu-app.onrender.com/health`. El bot suele responder con 200 y un mensaje breve.

---

## Resumen del flujo de despliegue

```
1. Render clona tu repo
2. Ejecuta: npm install && npm run build   →  genera dist/
3. Ejecuta: npm start                       →  node dist/bot.js
4. El bot lee PORT (ej: 10000) y WEBHOOK_URL
5. Crea servidor HTTP en ese puerto
6. Llama a setWebhook(WEBHOOK_URL + "/webhook")
7. Queda escuchando en /webhook para recibir updates de Telegram
```

Cada vez que hagas **push** a la rama conectada (si tienes auto-deploy activado) o pulses **Manual Deploy**, Render repite los pasos 1–3 y reinicia el bot.

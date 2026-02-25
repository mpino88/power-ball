# Bot de Telegram con botones

Bot de ejemplo con menú de opciones (botones inline), procesamiento y respuestas. Implementado en **TypeScript** (grammY) y también disponible en Python.

## Requisitos

- **Node.js 18+** (para la versión TypeScript)
- Token de bot de Telegram ([crear bot con @BotFather](https://t.me/BotFather))

## Instalación (TypeScript)

```bash
cd power-ball
npm install
```

## Configuración

Crea un bot en Telegram con [@BotFather](https://t.me/BotFather), copia el token y exporta la variable:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
```

## Ejecutar (TypeScript)

```bash
# Desarrollo (sin compilar)
npm run dev

# O compilar y ejecutar
npm run build
npm start
```

En Telegram: abre tu bot y envía `/start`. Verás los botones y al pulsar cada uno se ejecuta el procesamiento y se muestra el resultado.

## Opciones del bot

| Botón | Procesamiento | Resultado |
|-------|----------------|-----------|
| Generar números | Genera 5 números (1-69) + Power Ball (1-26) | Combinación mostrada |
| Calcular probabilidad | Calcula 1/(C(69,5)×26) | Probabilidad de jackpot |
| Otra combinación | Igual que Generar números | Nueva combinación |
| Ayuda | Texto fijo | Descripción de opciones |

## Estructura (TypeScript)

- `src/bot.ts` — Bot con grammY: teclado inline, handlers de `/start` y `callback_query`, y funciones de procesamiento.
- **Más opciones:** añade `.text("Label", "callback_data")` en `buildMainKeyboard()` y un `if (data === "tu_opcion")` en el handler de `callback_query:data`.
- **Otro procesamiento:** crea funciones como `processGenerateNumbers()` y llámalas desde el handler.

---

## Desplegar gratis (Render)

Para dejarlo en la nube **sin coste** y sin tarjeta: **[Instrucciones paso a paso en DEPLOY.md](DEPLOY.md)**. Resumen: subes el repo a GitHub, creas un Web Service en [Render](https://render.com), añades `TELEGRAM_BOT_TOKEN` y `WEBHOOK_URL`, y el bot queda disponible (en plan gratis puede tardar unos segundos en responder si el servicio estaba dormido).

---

## Otras formas de publicar el bot (dejarlo disponible 24/7)

Para que el bot esté siempre disponible (no solo cuando tu PC está encendido), hay que **desplegarlo** en un servidor en la nube. Opciones habituales:

### 1. Railway (recomendado para empezar)

1. Entra en [railway.app](https://railway.app) y conecta tu cuenta (GitHub si el código está en un repo).
2. **New Project** → **Deploy from GitHub repo** (o sube la carpeta del proyecto).
3. En el proyecto: **Variables** → añade `TELEGRAM_BOT_TOKEN` con el token de @BotFather.
4. Railway detecta Node.js. Si no, en **Settings**:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Root Directory:** (dejar vacío si la raíz del repo es el bot)
5. Deploy se hace solo en cada push. El bot queda corriendo y disponible para cualquiera que tenga el enlace.

### 2. Render

1. [render.com](https://render.com) → **New** → **Background Worker** (no Web Service).
2. Conecta el repo o sube el código.
3. **Build:** `npm install && npm run build`
4. **Start:** `npm start`
5. En **Environment** añade `TELEGRAM_BOT_TOKEN`.
6. Deploy. En el plan gratuito el worker puede “dormir” tras inactividad; al escribir al bot puede tardar unos segundos en despertar.

### 3. Fly.io

1. Instala [flyctl](https://fly.io/docs/hands-on/install-flyctl/) y haz `fly auth login`.
2. En la carpeta del proyecto: `fly launch` (crea `Dockerfile` o usa buildpacks).
3. `fly secrets set TELEGRAM_BOT_TOKEN=tu-token`
4. `fly deploy`. El bot corre en Fly y queda disponible.

### 4. VPS (DigitalOcean, Linode, etc.)

- Crea una máquina Linux, instala Node.js, clona el repo (o sube los archivos).
- `npm install && npm run build`, luego ejecuta con `npm start` dentro de un **process manager** como `pm2` para que se reinicie si se cae:
  ```bash
  npm i -g pm2
  export TELEGRAM_BOT_TOKEN="tu-token"
  pm2 start dist/bot.js --name power-ball-bot
  pm2 save && pm2 startup
  ```

**Importante:** en todos los casos el bot **no expone un puerto HTTP** (usa *long polling* con Telegram). En Railway/Render elige “Worker” o “Background Worker”, no “Web Service”, para no tener que configurar dominio ni puerto.

---

### Hacer el bot visible en la búsqueda de Telegram (opcional)

Para que aparezca en la búsqueda de bots de Telegram:

1. Abre [@BotFather](https://t.me/BotFather) en Telegram.
2. `/mybots` → elige tu bot.
3. **Edit Bot** → **Edit Description** y escribe una descripción corta (ej: “Genera números tipo Power Ball y calcula probabilidades”).
4. **Edit About** — texto que verán al abrir el perfil del bot.

Así tu bot sigue siendo “tuyo” (solo tú tienes el token) pero cualquiera puede encontrarlo buscando su nombre o enlace `t.me/tu_bot`.

---

## Versión Python

Si prefieres Python:

```bash
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN="tu-token"
python bot.py
```

Ver `bot.py` para la misma lógica con `python-telegram-bot`.

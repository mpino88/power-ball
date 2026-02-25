#!/usr/bin/env python3
"""
Bot de Telegram con menú de botones y procesamiento.
Ejemplo: generación de números tipo Power Ball y cálculos.
"""

import os
import random
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

# Configuración de logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Token del bot (usa variable de entorno)
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")


def build_main_keyboard() -> InlineKeyboardMarkup:
    """Construye el teclado principal con opciones."""
    keyboard = [
        [
            InlineKeyboardButton("🎱 Generar números", callback_data="generate"),
            InlineKeyboardButton("📊 Calcular probabilidad", callback_data="probability"),
        ],
        [
            InlineKeyboardButton("🔄 Otra combinación", callback_data="generate"),
            InlineKeyboardButton("❓ Ayuda", callback_data="help"),
        ],
    ]
    return InlineKeyboardMarkup(keyboard)


# --- Procesamiento ---

def process_generate_numbers() -> str:
    """Genera 5 números normales (1-69) y 1 Power Ball (1-26)."""
    white = sorted(random.sample(range(1, 70), 5))
    power = random.randint(1, 26)
    return f"*Tus números:*\n`{' - '.join(map(str, white))}`  |  *Power Ball:* `{power}`"


def process_probability() -> str:
    """Calcula probabilidad aproximada de acertar el jackpot."""
    # Combinaciones de 5 de 69 × 1 de 26
    from math import comb
    total = comb(69, 5) * 26
    prob = 1 / total
    return (
        f"*Probabilidad de jackpot:*\n"
        f"1 entre *{total:,}*\n\n"
        f"En decimal: ~{prob:.2e}"
    )


# --- Handlers ---

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Comando /start: mensaje de bienvenida y botones."""
    welcome = (
        "👋 *Hola!* Soy tu bot de ejemplo.\n\n"
        "Elige una opción con los botones:"
    )
    await update.message.reply_text(
        welcome,
        parse_mode="Markdown",
        reply_markup=build_main_keyboard(),
    )


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Responde a los clics en los botones (procesamiento y resultado)."""
    query = update.callback_query
    await query.answer()

    data = query.data
    result = ""

    if data == "generate":
        result = process_generate_numbers()
    elif data == "probability":
        result = process_probability()
    elif data == "help":
        result = (
            "*Opciones:*\n"
            "• *Generar números:* simula una combinación tipo Power Ball.\n"
            "• *Calcular probabilidad:* probabilidad de ganar el jackpot.\n"
            "• *Otra combinación:* vuelve a generar números."
        )
    else:
        result = "Opción no reconocida."

    await query.edit_message_text(
        text=result,
        parse_mode="Markdown",
        reply_markup=build_main_keyboard(),
    )


def main() -> None:
    if not BOT_TOKEN:
        print("Configura TELEGRAM_BOT_TOKEN en el entorno.")
        print("Ejemplo: export TELEGRAM_BOT_TOKEN='tu-token'")
        return

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_callback))

    logger.info("Bot en marcha...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

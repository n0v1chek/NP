require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ============ ЗАЩИТА ОТ ДВОЙНОГО ЗАПУСКА ============
const LOCK_FILE = path.join(__dirname, '.bot.lock');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (oldPid && isProcessRunning(oldPid)) {
        console.error(`❌ Бот уже запущен (PID: ${oldPid}). Второй экземпляр не будет запущен.`);
        // process.exit(1); // Закомментировано чтобы не было бесконечных рестартов
      }
      // Старый процесс мёртв, удаляем lock
      fs.unlinkSync(LOCK_FILE);
    }
    // Создаём lock с текущим PID
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    console.log(`🔒 Lock создан (PID: ${process.pid})`);
  } catch (e) {
    console.error('Ошибка создания lock файла:', e.message);
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      console.log('🔓 Lock удалён');
    }
  } catch (e) {}
}

// Получаем lock при старте
acquireLock();

// Удаляем lock при завершении
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const Replicate = require('replicate');
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())) || [];

// PostgreSQL database
const db = require('./db');

// YooKassa интеграция
const { createYooKassaPayment, getYooKassaPaymentStatus, parseYooKassaWebhook, TOPUP_AMOUNTS } = require('./yookassa');
const crypto = require('crypto');

const GENERATION_COST = 150; // 150 RUB за генерацию (Nano Banana Pro 2K)
const WEBHOOK_URL = process.env.REPLICATE_WEBHOOK_URL || `http://5.35.91.93:${process.env.PORT || 3001}/replicate-webhook`;
const WEBHOOK_SECRET = process.env.REPLICATE_WEBHOOK_SECRET;

// ============ ЭКРАНИРОВАНИЕ MARKDOWN ============
function escapeMarkdown(text) {
  if (!text) return text;
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ============ RETRY ЛОГИКА ДЛЯ REPLICATE API ============

async function generateWithRetry(prompt, base64Image, maxRetries = 3) {
  let lastError;
  let prediction = null;

  // Шаг 1: Создание prediction с retry для сетевых ошибок
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      prediction = await replicate.predictions.create({
        model: "google/nano-banana-pro",
        input: {
          prompt,
          image_input: [base64Image],
          resolution: "2K",
          aspect_ratio: "match_input_image",
          output_format: "jpg",
          safety_filter_level: "block_only_high"
        }
      });
      break; // Успешно создали - выходим из цикла
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || String(error);

      // Retry только для сетевых ошибок при создании
      const isNetworkError =
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('503') ||
        errorMsg.includes('502') ||
        errorMsg.includes('fetch failed');

      if (isNetworkError && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`[Retry] Create attempt ${attempt} failed: ${errorMsg}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  if (!prediction) {
    throw lastError || new Error('Failed to create prediction');
  }

  // Шаг 2: Ожидание результата (без retry - prediction уже оплачена)
  const completedPrediction = await replicate.wait(prediction);

  if (completedPrediction.error) {
    // Это ошибка выполнения (E004 и т.д.) - не делаем retry, prediction уже списана
    throw new Error(`Prediction failed: ${completedPrediction.error}`);
  }

  // Логируем расход в общую таблицу
  const costUsd = 0.15; // Цена google/nano-banana-pro
  await db.logReplicateUsage("google/nano-banana-pro", costUsd, prompt, completedPrediction.id);

  return completedPrediction;
}

// YooKassa конфигурация
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '1222788';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const BOT_URL = process.env.BOT_URL || 'https://t.me/NPotolki_bot';

// Express сервер для webhook YooKassa
const app = express();
app.use(express.json());

// ============ ВОДЯНОЙ ЗНАК (отключен) ============

async function addWatermark(imageUrl) {
  // Водяной знак отключен - возвращаем оригинальное изображение
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// ============ СОСТОЯНИЯ ============

const userStates = new Map();
const PROCESSING_TIMEOUT = 5 * 60 * 1000; // 5 минут таймаут для генерации
const STATE_TTL = 60 * 60 * 1000; // 1 час жизни state

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      photo: null,
      processing: false,
      processingStarted: null,
      config: getDefaultConfig(),
      step: null,
      tempData: {},
      lastActivity: Date.now()
    });
  }
  const state = userStates.get(userId);
  state.lastActivity = Date.now();

  // Автосброс processing если прошло больше 5 минут
  if (state.processing && state.processingStarted &&
      Date.now() - state.processingStarted > PROCESSING_TIMEOUT) {
    state.processing = false;
    state.processingStarted = null;
  }

  return state;
}

// Очистка старых state каждые 30 минут
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of userStates.entries()) {
    if (now - state.lastActivity > STATE_TTL) {
      userStates.delete(userId);
    }
  }
}, 30 * 60 * 1000);

function getDefaultConfig() {
  return {
    color: 'white',
    texture: 'matte',
    profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
    spots: { enabled: false, count: 6, type: 'round', color: 'white' },
    chandelier: { enabled: false, style: 'modern' },
    lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
    track: { enabled: false, count: 1, color: 'black' },
    ledStrip: { enabled: false, color: 'warm' },
    niche: false,
    twoLevel: false
  };
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ============ ПРОМПТЫ ДЛЯ ГЕНЕРАЦИИ ============

function buildPrompt(config) {
  // Структурированный промпт для лучшего понимания моделью

  const colorMap = {
    white: 'bright white', ivory: 'ivory/cream white', beige: 'beige/sand',
    gray: 'light gray', darkgray: 'dark gray', black: 'black',
    blue: 'light blue', pink: 'light pink'
  };

  const textureMap = {
    matte: 'matte finish (no reflections, no shine)',
    glossy: 'glossy finish (mirror-like, reflects room)',
    satin: 'satin finish (subtle soft sheen)',
    metallic: 'metallic finish (shimmer effect)'
  };

  const color = colorMap[config.color] || 'bright white';
  const texture = textureMap[config.texture] || 'matte finish';

  // Начинаем с чёткой инструкции
  let prompt = `Interior design photo edit. Task: replace the ceiling only.\n\n`;
  prompt += `CEILING: Modern stretched PVC ceiling membrane, ${color} color, ${texture}. `;
  prompt += `The ceiling surface spans from wall to wall seamlessly with perfectly smooth, taut finish. No visible seams or wrinkles.\n\n`;

  // Двухуровневый потолок
  if (config.twoLevel) {
    prompt += `MULTI-LEVEL: Add rectangular gypsum board frame (15cm drop) around room perimeter with integrated cove lighting.\n\n`;
  }

  // Обрабатываем профили для каждой стены
  const wallLabels = {
    back: 'back/far wall',
    front: 'front wall (near camera)',
    left: 'left wall',
    right: 'right wall'
  };

  const shadowWalls = [];
  const floatingWalls = [];

  for (const [wall, type] of Object.entries(config.profile)) {
    if (type === 'shadow') shadowWalls.push(wallLabels[wall]);
    if (type === 'floating') floatingWalls.push(wallLabels[wall]);
  }

  // Теневой зазор - критически важно описать правильно
  if (shadowWalls.length > 0) {
    const walls = shadowWalls.length === 4 ? 'all walls' : shadowWalls.join(' and ');
    prompt += `SHADOW GAP PROFILE at ${walls}: Where the ceiling meets the wall, install a 1cm black aluminum profile creating a recessed shadow line. `;
    prompt += `This creates a visual separation - the ceiling appears to not touch the wall, with a thin dark groove at the perimeter. `;
    prompt += `IMPORTANT: This is a physical RECESS (negative space) between ceiling and wall, not a painted line.\n\n`;
  }

  // Парящий потолок с подсветкой
  if (floatingWalls.length > 0) {
    const walls = floatingWalls.length === 4 ? 'all walls' : floatingWalls.join(' and ');
    prompt += `FLOATING CEILING with LED at ${walls}: The ceiling stops 3-4cm before reaching the wall. `;
    prompt += `In this gap, hidden LED strip creates warm white glow that washes down the wall. `;
    prompt += `You see the light effect on the wall, but the LED source is hidden in the ceiling gap.\n\n`;
  }

  // Точечные светильники (споты)
  if (config.spots.enabled && config.spots.count > 0) {
    const spotTypes = {
      round: 'round downlights', square: 'square panel lights',
      double: 'twin spotlights', gimbal: 'adjustable gimbal spots'
    };
    const spotColors = {
      white: 'white frames', black: 'black frames',
      gold: 'gold/brass frames', chrome: 'chrome frames'
    };

    const type = spotTypes[config.spots.type] || 'round downlights';
    const trim = spotColors[config.spots.color] || 'white frames';
    const count = config.spots.count;

    let arrangement = '';
    if (count <= 2) arrangement = 'in a line';
    else if (count === 4) arrangement = 'in 2x2 grid pattern';
    else if (count === 6) arrangement = 'in 2 rows of 3';
    else if (count === 8) arrangement = 'in 2 rows of 4';
    else if (count === 9) arrangement = 'in 3x3 grid';
    else if (count === 12) arrangement = 'in 3 rows of 4';
    else arrangement = 'evenly distributed';

    prompt += `RECESSED CEILING LIGHTS: ${count} small ${type} with ${trim}, ${arrangement}. `;
    prompt += `Each fixture is 6-8cm diameter, perfectly flush-mounted with ceiling surface, emitting warm white LED light (3000K). All lights are currently ON with moderate brightness. All lights are ON.\n\n`;
  }

  // Люстра/подвесной светильник
  if (config.chandelier.enabled) {
    const styles = {
      modern: 'modern minimalist pendant lamp',
      classic: 'classic chandelier with lampshades',
      crystal: 'crystal chandelier with glass drops',
      minimalist: 'thin LED ring pendant',
      sputnik: 'sputnik-style chandelier',
      ring: 'circular LED ring light',
      cluster: 'cluster pendant with glass globes',
      industrial: 'industrial metal pendant'
    };
    const style = styles[config.chandelier.style] || 'modern pendant lamp';
    prompt += `HANGING LIGHT: One ${style} suspended from center of ceiling. The light is turned ON.\n\n`;
  }

  // Световые линии
  if (config.lightlines.enabled && config.lightlines.count > 0) {
    const dirs = { along: 'lengthwise (along the room)', across: 'widthwise (across the room)', diagonal: 'diagonally' };
    const shapes = { straight: 'straight', geometric: 'geometric pattern', curved: 'curved' };

    const dir = dirs[config.lightlines.direction] || 'lengthwise';
    const shape = shapes[config.lightlines.shape] || 'straight';

    prompt += `LINEAR LED LIGHTS: ${config.lightlines.count} ${shape} LED light line(s) built into the ceiling, running ${dir}. `;
    prompt += `These are recessed light channels that glow bright white.\n\n`;
  }

  // Трековая система
  if (config.track.enabled) {
    const trackColor = config.track.color === 'white' ? 'white' : 'black';
    const trackCount = config.track.count || 1;
    if (trackCount === 1) {
      prompt += `TRACK LIGHTING: ${trackColor} track rail system mounted on ceiling, running through the center of the room lengthwise. `;
      prompt += `4-6 adjustable spotlight heads attached to the track, all pointing in various directions, lights ON.\n\n`;
    } else {
      prompt += `TRACK LIGHTING: ${trackCount} parallel ${trackColor} track rail systems mounted on ceiling, evenly distributed across the room. `;
      prompt += `Each track has 4-6 adjustable spotlight heads, all pointing in various directions, lights ON.\n\n`;
    }
  }

  // LED лента по периметру (отдельно от парящего)
  if (config.ledStrip.enabled) {
    const ledColors = { warm: 'warm white (yellowish)', cold: 'cool white (bluish)', rgb: 'colored RGB' };
    const ledColor = ledColors[config.ledStrip.color] || 'warm white';
    prompt += `PERIMETER LED STRIP: Hidden ${ledColor} LED lighting around entire ceiling edge, creating ambient glow effect on all walls.\n\n`;
  }

  // Ниша для штор
  if (config.niche) {
    prompt += `CURTAIN RECESS: At the window wall, ceiling has a 15cm deep slot/niche for hiding curtain rod and tracks.\n\n`;
  }

  // Финальные инструкции
  prompt += `CRITICAL: Only modify the ceiling area. Preserve walls, floor, furniture, windows, doors, and all room contents exactly as in original photo. `;
  prompt += `Maintain identical camera angle and perspective. Preserve all original natural and artificial lighting sources. Keep same light/shadow patterns on walls and objects. Photorealistic quality - must look like real photograph, not CGI render.`;

  return prompt;
}

// ============ СВОДКА ============

function buildSummary(config) {
  const colors = { white: '⬜ Белый', ivory: '🤍 Айвори', beige: '🟨 Бежевый', gray: '⬛ Серый', darkgray: '🖤 Тёмно-серый', black: '⚫ Чёрный', blue: '🔵 Голубой', pink: '🩷 Розовый' };
  const textures = { matte: 'Матовый', glossy: 'Глянцевый', satin: 'Сатиновый', metallic: 'Металлик' };
  const profiles = { none: '—', shadow: 'Теневой', floating: 'Парящий' };

  const lines = [];
  lines.push(`🎨 ${colors[config.color] || 'Белый'} • ${textures[config.texture] || 'Матовый'}`);
  if (config.twoLevel) lines.push(`🏗 Двухуровневый`);

  const activeProfiles = Object.entries(config.profile).filter(([,v]) => v !== 'none');
  if (activeProfiles.length > 0) {
    const wallNames = { back: 'зад', front: 'перед', left: 'лево', right: 'право' };
    const profileStr = activeProfiles.map(([w, p]) => `${wallNames[w]}: ${profiles[p]}`).join(', ');
    lines.push(`📐 ${profileStr}`);
  }

  const lighting = [];
  if (config.spots.enabled) lighting.push(`💡 ${config.spots.count} спотов`);
  if (config.chandelier.enabled) lighting.push(`🪔 Люстра`);
  if (config.lightlines.enabled) lighting.push(`📏 ${config.lightlines.count} линий`);
  if (config.track.enabled) lighting.push(`🔦 ${config.track.count} трек(а)`);
  if (config.ledStrip.enabled) lighting.push(`💫 LED`);
  if (lighting.length > 0) lines.push(lighting.join(' • '));
  if (config.niche) lines.push(`🪟 Ниша для штор`);

  return lines.join('\n');
}

// ============ ГЛАВНОЕ МЕНЮ ============

// Постоянная клавиатура внизу экрана
function persistentKeyboard(isAdminUser, user = null) {
  if (isAdminUser) {
    return Markup.keyboard([
      ['📸 Новая визуализация', '🖼 Мои работы'],
      ['💳 Пополнение', '👑 Админ-панель'],
      ['📖 Помощь']
    ]).resize();
  }

  if (user?.user_type === 'company_owner') {
    return Markup.keyboard([
      ['📸 Новая визуализация', '🖼 Мои работы'],
      ['💰 Баланс', '💳 Пополнить'],
      ['🏢 Моя компания', '📊 Статистика'],
      ['📖 Помощь', '⚠️ Сообщить о проблеме']
    ]).resize();
  }

  if (user?.user_type === 'employee') {
    return Markup.keyboard([
      ['📸 Новая визуализация', '🖼 Мои работы'],
      ['💰 Баланс', '📊 Статистика'],
      ['📖 Помощь', '⚠️ Сообщить о проблеме']
    ]).resize();
  }

  // individual
  return Markup.keyboard([
    ['📸 Новая визуализация', '🖼 Мои работы'],
    ['💰 Баланс', '💳 Пополнить'],
    ['📖 Помощь', '⚠️ Сообщить о проблеме']
  ]).resize();
}

async function mainMenuKeyboard(userId) {
  const user = await db.getUser(userId);
  const buttons = [];

  if (isAdmin(userId)) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('🖼 Мои работы', 'my_works')]);
    buttons.push([Markup.button.callback('💳 Оплата / Пополнение', 'pay_balance')]);
    buttons.push([Markup.button.callback('👑 Админ-панель', 'admin')]);
  } else if (user) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('🖼 Мои работы', 'my_works')]);
    buttons.push([Markup.button.callback('💰 Баланс: ' + (user.balance || 0) + ' ₽', 'balance')]);
    buttons.push([Markup.button.callback('💳 Пополнить баланс', 'pay_balance')]);
  }

  return Markup.inlineKeyboard(buttons);
}

// ============ КОМАНДА START ============

bot.command('start', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  const tips = [
    '💡 _Визуализация за 30 секунд — покажите клиенту прямо на встрече!_',
    '🚀 _Генерация потолка за секунды — удивите клиента!_',
    '💰 _Визуализация повышает конверсию — клиент видит результат до заказа_',
    '📸 _Фото → Визуализация → Продажа. Просто загрузите фото комнаты_',
    '🎯 _Клиент видит потолок на своём фото — легче продавать_',
    '🎨 _Покажите потолок до установки_'
  ];
  const disclaimer = tips[Math.floor(Math.random() * tips.length)];

  if (isAdmin(userId)) {
    let text = '🏠 *Визуализация натяжных потолков*\n\n';
    text += '👑 Вы администратор\n\n';
    text += disclaimer;
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...persistentKeyboard(isAdmin(userId), user)
    });
    return;
  }

  if (user) {
    // Пользователь зарегистрирован
    let text = '🏠 *Визуализация натяжных потолков*\n\n';

    if (user.user_type === 'company_owner') {
      const company = await db.getCompanyByOwner(userId);
      const stats = await db.getCompanyStats(company.id);
      text += `🏢 *${company?.name || 'Компания'}* (владелец)\n`;
      text += `🔑 Код для сотрудников: \`${company?.invite_code || 'N/A'}\`\n`;
      text += `_Передайте этот код сотрудникам для входа_\n\n`;
      text += `💰 Ваш баланс: ${user.balance} ₽\n`;
      text += `🏦 Общий счёт: ${company?.shared_balance || 0} ₽\n`;
      text += `👥 Сотрудников: ${stats.employees_count}\n\n`;
    } else if (user.user_type === 'employee') {
      const company = await db.getCompany(user.company_id);
      text += `🏢 ${company?.name || 'Компания'} (сотрудник)\n`;
      text += `💰 Баланс: ${user.balance} ₽\n\n`;
    } else {
      // individual
      text += `👤 ${user.name || 'Частный пользователь'}\n`;
      text += `💰 Баланс: ${user.balance} ₽\n\n`;
    }

    text += disclaimer;

    // Проверяем приглашения в компании
    const invites = await db.getPendingInvites(userId);
    if (invites.length > 0) {
      text += `\n\n📬 У вас ${invites.length} приглашение(й) в компании!`;
    }

    // Проверяем запрос на передачу прав
    const transfer = await db.getPendingTransfer(userId);
    if (transfer) {
      text += `\n\n🔔 Вам предлагают стать владельцем компании "${transfer.company_name}"!`;
    }

    // Инлайн-кнопки для владельца компании
    if (user.user_type === 'company_owner') {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Пригласить сотрудника', 'invite_employee')],
          [Markup.button.callback('💸 Распределить баланс', 'distribute_balance')],
          [Markup.button.callback('💳 Пополнить баланс', 'topup_menu')]
        ])
      });
      // Отправляем клавиатуру
      await ctx.reply('⬇️', persistentKeyboard(false, user));
      return;
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...persistentKeyboard(false, user)
    });
    return;
  }

  // Новый пользователь - показываем выбор регистрации
  const welcomeText = `🏠 *Визуализация натяжных потолков*

🎯 *Что вы получите:*

📸 *Мгновенная визуализация* — загрузите фото комнаты и получите реалистичный результат за 30-60 секунд

🎨 *Гибкие настройки:*
• Цвета, текстуры, профили
• Точечные светильники, люстры
• Световые линии, трековые системы
• LED-подсветка, двухуровневые потолки

💼 *Идеально для:*
• Показа клиенту прямо на замере
• Презентации вариантов в офисе
• Согласования дизайна до монтажа

_Стоимость: 150₽ за генерацию_

📝 *Выберите тип регистрации:*

👤 *Частный пользователь*
   Для личного использования. Собственный баланс.

🏢 *Создать компанию*
   Для владельца бизнеса. Общий счёт, приглашение сотрудников.

👥 *Присоединиться к компании*
   Для сотрудника. Нужен код от руководителя.`;

  await ctx.reply(welcomeText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('👤 Частный пользователь', 'register_individual')],
      [Markup.button.callback('🏢 Создать компанию', 'register_company')],
      [Markup.button.callback('👥 Присоединиться к компании', 'join_company')]
    ])
  });
});

// ============ ОБРАБОТКА КНОПОК КЛАВИАТУРЫ ============

bot.hears('📸 Новая визуализация', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств.\n\nНужно: ${GENERATION_COST} ₽\nВаш баланс: ${user.balance} ₽`,
      Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
    );
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();
  state.step = 'waiting_photo';

  await ctx.reply(
    '📸 *Новая визуализация*\n\n' +
    'Отправьте фото комнаты для визуализации потолка.\n\n' +
    '*Как правильно сделать фото:*\n' +
    '✅ Должны быть видны 3 стены и потолок\n' +
    '✅ Потолок — около ⅓ кадра\n' +
    '✅ Телефон горизонтально\n' +
    '✅ Не снимайте против света из окна\n\n' +
    '❌ _Если не видно границу стены и потолка — результат будет некорректным_',
    { parse_mode: 'Markdown' }
  );
});

bot.hears('🖼 Мои работы', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа.');
  }

  const allGenerations = await db.getUserGenerations(userId);
  const generations = allGenerations.slice(0, 10);

  if (generations.length === 0) {
    return ctx.reply(
      '🖼 *Мои работы*\n\nУ вас пока нет генераций.\n\nНажмите "📸 Новая визуализация" чтобы создать первую!',
      { parse_mode: 'Markdown' }
    );
  }

  const buttons = generations.map((gen, index) => {
    const date = new Date(gen.created_at).toLocaleDateString('ru-RU');
    const colors = { white: '⬜', ivory: '🤍', beige: '🟨', gray: '⬛', darkgray: '🖤', black: '⚫', blue: '🔵', pink: '🩷' };
    const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;
    const colorIcon = colors[config?.color] || '⬜';
    return [Markup.button.callback(`${colorIcon} ${date} #${generations.length - index}`, `view_work_${gen.id}`)];
  });

  await ctx.reply(
    `🖼 *Мои работы*\n\nПоследние ${generations.length} генераций:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.hears('💰 Баланс', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  const gensAvailable = Math.floor(user.balance / GENERATION_COST);
  await ctx.reply(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${gensAvailable}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить', 'pay_balance')],
        [Markup.button.callback('📜 История', 'history')]
      ])
    }
  );
});

bot.hears(['💳 Пополнить', '💳 Пополнение'], async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  await showTopupMenu(ctx, user || { balance: 0, user_type: 'individual' });
});

bot.hears('👑 Админ-панель', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const stats = await db.getStats();

  await ctx.reply(
    '👑 *Админ-панель*\n\n' +
    `🏢 Компаний: ${stats.companies_count}\n` +
    `👥 Пользователей: ${stats.users_count}` + (parseInt(stats.blocked_count) > 0 ? ` (🚫 ${stats.blocked_count})` : '') + '\n' +
    `💰 Баланс на счетах: ${stats.total_balance} ₽\n` +
    `🖼 Всего генераций: ${stats.generations_count}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏢 Компании', 'admin_companies'), Markup.button.callback('👤 Частники', 'admin_individuals')],
        [Markup.button.callback('👥 Все пользователи', 'admin_all_users')],
        [Markup.button.callback(`📋 Заявки (${stats.requests_count})`, 'admin_requests')],
        [Markup.button.callback('⚠️ Низкий баланс', 'admin_low_balance')],
        [Markup.button.callback('📊 Статистика', 'admin_stats'), Markup.button.callback('💳 Транзакции', 'admin_transactions')],
        [Markup.button.callback('💵 Расходы API', 'admin_api_costs')]
      ])
    }
  );
});

bot.hears('📖 Помощь', async ctx => {
  const helpText = `📖 *Помощь*

*Как пользоваться ботом:*

1️⃣ Нажмите "📸 Новая визуализация"
2️⃣ Загрузите фото комнаты
3️⃣ Настройте параметры потолка
4️⃣ Нажмите "Сгенерировать"
5️⃣ Получите результат за 30-60 сек

*Доступные настройки:*
🎨 Цвет и текстура потолка
📐 Профили (теневой, парящий)
🏗 Уровни (одно-/двухуровневый)
💡 Освещение (споты, люстры, линии)
💫 LED-подсветка и ниши

*Стоимость:* 150₽ за генерацию`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// Обработчик кнопки "Сообщить о проблеме"
const reportStates = new Map(); // userId -> { step, data }

bot.hears('⚠️ Сообщить о проблеме', async ctx => {
  const userId = ctx.from.id;

  reportStates.set(userId, { step: 'waiting_description' });

  await ctx.reply(
    '⚠️ *Сообщить о проблеме*\n\n' +
    'Опишите проблему, с которой вы столкнулись.\n' +
    'Мы решим проблему в ближайшее время.\n\n' +
    '_Напишите текст сообщения или нажмите /cancel для отмены:_',
    { parse_mode: 'Markdown' }
  );
});

// Обработка описания проблемы
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = reportStates.get(userId);

  if (!state || state.step !== 'waiting_description') {
    return next();
  }

  const text = ctx.message.text;

  // Отмена
  if (text === '/cancel') {
    reportStates.delete(userId);
    return ctx.reply('❌ Отправка отменена.');
  }

  // Игнорируем команды меню
  if (text.startsWith('/') || text.startsWith('📸') || text.startsWith('🖼') ||
      text.startsWith('💰') || text.startsWith('💳') || text.startsWith('📖') ||
      text.startsWith('🏢') || text.startsWith('📊') || text.startsWith('👑')) {
    reportStates.delete(userId);
    return next();
  }

  reportStates.delete(userId);

  // Получаем информацию о пользователе
  const user = await db.getUser(userId);
  const username = ctx.from.username ? `@${ctx.from.username}` : 'нет';
  const firstName = ctx.from.first_name || 'Неизвестно';

  // Формируем сообщение для админа
  const adminMessage =
    `⚠️ *СООБЩЕНИЕ О ПРОБЛЕМЕ*\n\n` +
    `👤 *От:* ${firstName}\n` +
    `🆔 *ID:* \`${userId}\`\n` +
    `📱 *Username:* ${username}\n` +
    `💰 *Баланс:* ${user?.balance || 0}₽\n` +
    `📅 *Время:* ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}\n\n` +
    `📝 *Сообщение:*\n${text}`;

  // Отправляем всем админам
  let sent = false;
  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId, adminMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '💬 Ответить', url: `tg://user?id=${userId}` }
          ]]
        }
      });
      sent = true;
    } catch (e) {
      console.error(`Failed to send report to admin ${adminId}:`, e.message);
    }
  }

  if (sent) {
    await ctx.reply(
      '✅ *Сообщение отправлено!*\n\n' +
      'Мы получили ваше сообщение и решим проблему в ближайшее время.',
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply('❌ Не удалось отправить сообщение. Попробуйте позже.');
  }
});

// ============ ДОПОЛНИТЕЛЬНЫЕ КОМАНДЫ ============

bot.command('help', async ctx => {
  const helpText = `📖 *Помощь*

*Как пользоваться ботом:*

1️⃣ Нажмите "Новая визуализация"
2️⃣ Загрузите фото комнаты
3️⃣ Настройте параметры потолка
4️⃣ Нажмите "Сгенерировать"
5️⃣ Получите результат за 30-60 сек

*Доступные настройки:*
🎨 Цвет и текстура потолка
📐 Профили (теневой, парящий)
🏗 Уровни (одно-/двухуровневый)
💡 Освещение (споты, люстры, линии)
💫 LED-подсветка и ниши

*Команды:*
/start — главное меню
/new — новая визуализация
/balance — проверить баланс
/help — эта справка

*Стоимость:* 150₽ за генерацию`;

  await ctx.reply(helpText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'back_main')]])
  });
});

bot.command('balance', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (isAdmin(userId)) {
    return ctx.reply('👑 Вы администратор — баланс не ограничен!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'back_main')]])
    });
  }

  const gensAvailable = Math.floor(user.balance / GENERATION_COST);
  await ctx.reply(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${gensAvailable}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить', 'pay_balance')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    }
  );
});

bot.command('new', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств.\n\nНужно: ${GENERATION_COST} ₽\nВаш баланс: ${user.balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
      }
    );
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();
  state.step = 'waiting_photo';

  await ctx.reply(
    '📸 *Новая визуализация*\n\n' +
    'Отправьте фото комнаты для визуализации потолка.\n\n' +
    '*Как правильно сделать фото:*\n' +
    '✅ Должны быть видны 3 стены и потолок\n' +
    '✅ Потолок — около ⅓ кадра\n' +
    '✅ Телефон горизонтально\n' +
    '✅ Не снимайте против света из окна\n\n' +
    '❌ _Если не видно границу стены и потолка — результат будет некорректным_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_main')]])
    }
  );
});

// ============ ЗАПРОС ДОСТУПА ============

bot.action('request_access', async ctx => {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';

  const request = await db.addAccessRequest(userId, username, firstName, lastName);

  if (!request) {
    await ctx.answerCbQuery('Заявка уже отправлена');
    return;
  }

  await ctx.answerCbQuery('Заявка отправлена!');
  await ctx.editMessageText(
    '🏠 *Визуализация натяжных потолков*\n\n' +
    '✅ Заявка отправлена!\n\n' +
    'Ожидайте подтверждения администратора.',
    { parse_mode: 'Markdown' }
  );

  // Уведомляем админов
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
  const userLink = username ? `@${username}` : `ID: ${userId}`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId,
        `📋 *Новая заявка на доступ*\n\n` +
        `👤 ${displayName}\n` +
        `📱 ${userLink}\n` +
        `🆔 \`${userId}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('👀 Посмотреть заявки', 'admin_requests')]])
        }
      );
    } catch (e) {}
  }
});

// ============ БАЛАНС ============

bot.action('balance', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Нет доступа');
  }

  const balance = user?.balance || 0;
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `💰 *Ваш баланс: ${balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${Math.floor(balance / GENERATION_COST)}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить баланс', 'pay_balance')],
        [Markup.button.callback('📜 История', 'history')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

bot.action('history', async ctx => {
  const userId = ctx.from.id;
  const transactions = await db.getUserTransactions(userId);
  const lastTen = transactions.slice(0, 10);

  let text = '📜 *История операций*\n\n';
  if (lastTen.length === 0) {
    text += 'Пока нет операций';
  } else {
    lastTen.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
      text += `${sign}${t.amount} ₽ — ${t.description} (${date})\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'balance')]])
  });
});

// ============ МОИ РАБОТЫ ============

bot.action('my_works', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Нет доступа');
  }

  const allGenerations = await db.getUserGenerations(userId);
  const generations = allGenerations.slice(0, 10);

  if (generations.length === 0) {
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🖼 *Мои работы*\n\nУ вас пока нет генераций.\n\nНажмите "Новая визуализация" чтобы создать первую!',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📸 Новая визуализация', 'new_visual')],
          [Markup.button.callback('⬅️ Назад', 'back_main')]
        ])
      }
    );
  }

  // Показываем список генераций
  const buttons = generations.map((gen, index) => {
    const date = new Date(gen.created_at).toLocaleDateString('ru-RU');
    const colors = { white: '⬜', ivory: '🤍', beige: '🟨', gray: '⬛', darkgray: '🖤', black: '⚫', blue: '🔵', pink: '🩷' };
    const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;
    const colorIcon = colors[config?.color] || '⬜';
    return [Markup.button.callback(`${colorIcon} ${date} #${generations.length - index}`, `view_work_${gen.id}`)];
  });

  buttons.push([Markup.button.callback('⬅️ Назад', 'back_main')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🖼 *Мои работы*\n\nПоследние ${generations.length} генераций:\n\n` +
    '_Нажмите на работу чтобы посмотреть_\n' +
    '_⚠️ Изображения доступны ~24 часа_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^view_work_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const genId = parseInt(ctx.match[1]);

  const generations = await db.getUserGenerations(userId);
  const gen = generations.find(g => g.id === genId);

  if (!gen) {
    return ctx.answerCbQuery('Работа не найдена');
  }

  await ctx.answerCbQuery();

  const date = new Date(gen.created_at).toLocaleString('ru-RU');
  const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;

  if (gen.result_url) {
    try {
      // Добавляем водяной знак
      const watermarkedImage = await addWatermark(gen.result_url);

      await ctx.replyWithPhoto({ source: watermarkedImage }, {
        caption: `🖼 *Генерация от ${date}*\n\n` + buildSummary(config),
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 К списку работ', 'my_works')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      });
    } catch (e) {
      // URL истёк
      await ctx.reply(
        `🖼 *Генерация от ${date}*\n\n` +
        buildSummary(config) +
        '\n\n⚠️ _Изображение больше недоступно (истёк срок хранения)_',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 К списку работ', 'my_works')],
            [Markup.button.callback('🏠 Меню', 'back_main')]
          ])
        }
      );
    }
  } else {
    await ctx.reply(
      `🖼 *Генерация от ${date}*\n\n` +
      buildSummary(config) +
      '\n\n⚠️ _Изображение не сохранено_',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 К списку работ', 'my_works')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      }
    );
  }
});

// ============ АДМИН-ПАНЕЛЬ ============

bot.action('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const stats = await db.getStats();

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👑 *Админ-панель*\n\n' +
    `🏢 Компаний: ${stats.companies_count}\n` +
    `👥 Пользователей: ${stats.users_count}` + (parseInt(stats.blocked_count) > 0 ? ` (🚫 ${stats.blocked_count})` : '') + '\n' +
    `💰 Баланс на счетах: ${stats.total_balance} ₽\n` +
    `🖼 Всего генераций: ${stats.generations_count}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏢 Компании', 'admin_companies'), Markup.button.callback('👤 Частники', 'admin_individuals')],
        [Markup.button.callback('👥 Все пользователи', 'admin_all_users')],
        [Markup.button.callback(`📋 Заявки (${stats.requests_count})`, 'admin_requests')],
        [Markup.button.callback('⚠️ Низкий баланс', 'admin_low_balance')],
        [Markup.button.callback('📊 Статистика', 'admin_stats'), Markup.button.callback('💳 Транзакции', 'admin_transactions')],
        [Markup.button.callback('💵 Расходы API', 'admin_api_costs')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

// ============ НИЗКИЙ БАЛАНС ============

bot.action('admin_low_balance', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const lowBalanceUsers = await db.getLowBalanceUsers(150); // 2 генерации = 150₽

  await ctx.answerCbQuery();

  if (lowBalanceUsers.length === 0) {
    await ctx.editMessageText(
      '⚠️ *Пользователи с низким балансом*\n\n' +
      '✅ Нет пользователей с балансом ≤150₽',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
      }
    );
    return;
  }

  let text = `⚠️ *Пользователи с низким балансом*\n\n`;
  text += `Пользователей: ${lowBalanceUsers.length}\n\n`;

  lowBalanceUsers.slice(0, 15).forEach((u, i) => {
    const gensLeft = Math.floor(u.balance / GENERATION_COST);
    text += `${i + 1}. ${u.name || 'Без имени'} (${u.company_name || '—'})\n`;
    text += `   💰 ${u.balance}₽ = ${gensLeft} генераций\n`;
  });

  if (lowBalanceUsers.length > 15) {
    text += `\n...и ещё ${lowBalanceUsers.length - 15} пользователей`;
  }

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📨 Уведомить всех', 'notify_low_balance')],
      [Markup.button.callback('⬅️ Назад', 'admin')]
    ])
  });
});

bot.action('notify_low_balance', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const lowBalanceUsers = await db.getLowBalanceUsers(150);
  let sent = 0;

  for (const user of lowBalanceUsers) {
    try {
      const gensLeft = Math.floor(user.balance / GENERATION_COST);
      await bot.telegram.sendMessage(user.id,
        `⚠️ *Низкий баланс*\n\n` +
        `Ваш баланс: ${user.balance}₽\n` +
        `Осталось генераций: ${gensLeft}\n\n` +
        `Пополните баланс, чтобы продолжить создавать визуализации!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
        }
      );
      sent++;
    } catch (e) {
      // Пользователь заблокировал бота
    }
  }

  await ctx.answerCbQuery(`Уведомлено ${sent} из ${lowBalanceUsers.length} пользователей`);
});

// ============ ВСЕ ПОЛЬЗОВАТЕЛИ ============

bot.action('admin_all_users', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const users = Object.values(await db.getAllUsers());
  const companies = await db.getCompanies();

  if (users.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('👥 *Все пользователи*\n\nНет пользователей', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
    return;
  }

  // Сортируем: сначала активные, потом заблокированные
  users.sort((a, b) => {
    if (a.blocked && !b.blocked) return 1;
    if (!a.blocked && b.blocked) return -1;
    return (b.balance || 0) - (a.balance || 0);
  });

  const buttons = users.slice(0, 15).map(u => {
    const company = companies[u.company_id];
    const status = u.blocked ? '🚫' : '✅';
    const name = u.name || 'ID:' + u.id;
    return [Markup.button.callback(`${status} ${name} (${u.balance}₽)`, `admin_user_${u.id}`)];
  });

  if (users.length > 15) {
    buttons.push([Markup.button.callback(`... ещё ${users.length - 15} пользователей`, 'admin_all_users_more')]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`👥 *Все пользователи (${users.length})*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// ============ ЧАСТНИКИ ============

bot.action('admin_individuals', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const allUsers = Object.values(await db.getAllUsers());
  const individuals = allUsers.filter(u => u.user_type === 'individual');

  if (individuals.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('👤 *Частные пользователи*\n\nНет частных пользователей', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить частника', 'add_individual')],
        [Markup.button.callback('⬅️ Назад', 'admin')]
      ])
    });
    return;
  }

  // Сортируем по балансу
  individuals.sort((a, b) => (b.balance || 0) - (a.balance || 0));

  const buttons = individuals.slice(0, 15).map(u => {
    const status = u.blocked ? '🚫' : '✅';
    const name = u.name || 'ID:' + u.id;
    return [Markup.button.callback(`${status} ${name} (${u.balance}₽)`, `admin_user_${u.id}`)];
  });

  if (individuals.length > 15) {
    buttons.push([Markup.button.callback(`... ещё ${individuals.length - 15}`, 'admin_individuals_more')]);
  }

  buttons.push([Markup.button.callback('➕ Добавить частника', 'add_individual')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`👤 *Частные пользователи (${individuals.length})*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Добавление частника админом
bot.action('add_individual', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const state = getState(ctx.from.id);
  state.step = 'add_individual_id';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '➕ *Добавить частного пользователя*\n\n' +
    'Введите Telegram ID пользователя:\n\n' +
    '_Или перешлите сообщение от пользователя_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_individuals')]])
    }
  );
});

// Детальный просмотр пользователя (расширенный)
bot.action(/^admin_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = await db.getCompany(user.company_id);
  const gens = await db.getUserGenerations(userId);
  const txs = await db.getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.created_at).toLocaleDateString('ru-RU');

  let text = `👤 *${escapeMarkdown(user.name) || 'Без имени'}*\n\n`;
  text += `🆔 ID: \`${userId}\`\n`;
  text += `🏢 Компания: ${escapeMarkdown(company?.name) || '—'}\n`;
  text += `💰 Баланс: ${user.balance} ₽\n`;
  text += `🖼 Генераций: ${gens.length}\n`;
  text += `💸 Потрачено: ${totalSpent} ₽\n`;
  text += `📅 Регистрация: ${regDate}\n`;
  text += `📊 Статус: ${user.blocked ? '🚫 Заблокирован' : '✅ Активен'}`;

  const buttons = [
    [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`), Markup.button.callback('💸 Списать', `deduct_user_${userId}`)],
    [Markup.button.callback(user.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `toggle_block_${userId}`)],
    [Markup.button.callback('🔄 Сменить компанию', `change_company_${userId}`)],
    [Markup.button.callback('📜 История операций', `user_history_${userId}`)],
    [Markup.button.callback('🗑 Удалить', `confirm_delete_user_${userId}`)],
    [Markup.button.callback('⬅️ Назад', 'admin_all_users')]
  ];

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Блокировка/разблокировка
bot.action(/^toggle_block_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const newStatus = !user.blocked;
  await db.updateUser(userId, { blocked: newStatus });

  // Уведомляем пользователя
  try {
    if (newStatus) {
      await bot.telegram.sendMessage(userId, '🚫 Ваш доступ заблокирован администратором.');
    } else {
      await bot.telegram.sendMessage(userId, '✅ Ваш доступ восстановлен.');
    }
  } catch (e) {}

  await ctx.answerCbQuery(newStatus ? 'Заблокирован' : 'Разблокирован');

  // Обновляем экран
  const company = await db.getCompany(user.company_id);
  const gens = await db.getUserGenerations(userId);
  const txs = await db.getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.created_at).toLocaleDateString('ru-RU');

  let text = `👤 *${escapeMarkdown(user.name) || 'Без имени'}*\n\n`;
  text += `🆔 ID: \`${userId}\`\n`;
  text += `🏢 Компания: ${escapeMarkdown(company?.name) || '—'}\n`;
  text += `💰 Баланс: ${user.balance} ₽\n`;
  text += `🖼 Генераций: ${gens.length}\n`;
  text += `💸 Потрачено: ${totalSpent} ₽\n`;
  text += `📅 Регистрация: ${regDate}\n`;
  text += `📊 Статус: ${newStatus ? '🚫 Заблокирован' : '✅ Активен'}`;

  const buttons = [
    [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`), Markup.button.callback('💸 Списать', `deduct_user_${userId}`)],
    [Markup.button.callback(newStatus ? '✅ Разблокировать' : '🚫 Заблокировать', `toggle_block_${userId}`)],
    [Markup.button.callback('🔄 Сменить компанию', `change_company_${userId}`)],
    [Markup.button.callback('📜 История операций', `user_history_${userId}`)],
    [Markup.button.callback('🗑 Удалить', `confirm_delete_user_${userId}`)],
    [Markup.button.callback('⬅️ Назад', 'admin_all_users')]
  ];

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Списание с баланса
bot.action(/^deduct_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const state = getState(ctx.from.id);
  state.tempData.deductUserId = userId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💸 *Списание с баланса*\n\n` +
    `👤 ${user.name || 'ID:' + userId}\n` +
    `💰 Текущий баланс: ${user.balance} ₽\n\n` +
    `Выберите сумму списания:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('100 ₽', 'do_deduct_100'), Markup.button.callback('500 ₽', 'do_deduct_500')],
        [Markup.button.callback('1000 ₽', 'do_deduct_1000'), Markup.button.callback('Весь баланс', `do_deduct_${user.balance}`)],
        [Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_deduct_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const state = getState(ctx.from.id);
  const amount = parseInt(ctx.match[1]);
  const userId = state.tempData.deductUserId;

  if (!userId) return ctx.answerCbQuery('Ошибка');

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const deductAmount = Math.min(amount, user.balance);
  if (deductAmount <= 0) return ctx.answerCbQuery('Нечего списывать');

  await db.updateUser(userId, { balance: user.balance - deductAmount });
  await db.addTransaction(userId, -deductAmount, 'deduct', 'Списание администратором');

  try {
    await bot.telegram.sendMessage(userId, `💸 С вашего баланса списано ${deductAmount} ₽\n\nТекущий баланс: ${user.balance - deductAmount} ₽`);
  } catch (e) {}

  state.tempData = {};

  await ctx.answerCbQuery(`Списано ${deductAmount} ₽`);
  await ctx.editMessageText(`✅ Списано ${deductAmount} ₽`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователю', `admin_user_${userId}`)]])
  });
});

// Смена компании
bot.action(/^change_company_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companies = Object.values(await db.getCompanies());

  if (companies.length === 0) {
    return ctx.answerCbQuery('Нет компаний');
  }

  const buttons = companies.map(c => [
    Markup.button.callback(
      (c.id === user.company_id ? '✅ ' : '') + c.name,
      `set_company_${userId}_${c.id}`
    )
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🔄 *Смена компании*\n\n👤 ${escapeMarkdown(user.name)}\n\nВыберите новую компанию:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^set_company_(\d+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const companyId = ctx.match[2];

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  await db.updateUser(userId, { companyId });

  await ctx.answerCbQuery(`Перемещён в ${company.name}`);
  await ctx.editMessageText(`✅ Пользователь перемещён в "${company.name}"`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователю', `admin_user_${userId}`)]])
  });
});

// История операций пользователя
bot.action(/^user_history_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const txs = (await db.getUserTransactions(userId)).slice(-15).reverse();

  let text = `📜 *История операций*\n\n`;

  if (txs.length === 0) {
    text += 'Нет операций';
  } else {
    txs.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
      text += `${sign}${t.amount} ₽ — ${t.description} (${date})\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]])
  });
});

// Подтверждение удаления пользователя
bot.action(/^confirm_delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🗑 *Удалить пользователя?*\n\n` +
    `👤 ${user.name || 'ID:' + userId}\n` +
    `💰 Баланс: ${user.balance} ₽\n\n` +
    `⚠️ Действие необратимо!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', `do_delete_user_${userId}`)],
        [Markup.button.callback('❌ Отмена', `admin_user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  await db.deleteUser(userId);

  await ctx.answerCbQuery('Удалён');
  await ctx.editMessageText('✅ Пользователь удалён', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователям', 'admin_all_users')]])
  });
});

// ============ ТРАНЗАКЦИИ ============

bot.action('admin_transactions', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const txs = (await db.getAllTransactions()).slice(-20).reverse();
  const users = await db.getAllUsers();

  let text = `💳 *Последние транзакции*\n\n`;

  if (txs.length === 0) {
    text += 'Нет транзакций';
  } else {
    txs.forEach(t => {
      const user = users[t.user_id];
      const userName = user?.name || 'ID:' + t.user_id;
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
      const icon = t.type === 'topup' ? '💰' : t.type === 'generation' ? '🖼' : '💸';
      text += `${icon} ${sign}${t.amount}₽ | ${userName} | ${date}\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
  });
});

// ============ ЗАЯВКИ НА ДОСТУП ============

bot.action('admin_requests', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const requests = await db.getAccessRequests();

  if (requests.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
    return;
  }

  const buttons = requests.slice(0, 10).map(r => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
    const tag = r.username ? `@${r.username}` : '';
    return [Markup.button.callback(`👤 ${name} ${tag}`, `view_request_${r.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`📋 *Заявки на доступ (${requests.length})*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^view_request_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const requestId = parseInt(ctx.match[1]);
  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const name = [request.first_name, request.last_name].filter(Boolean).join(' ') || 'Без имени';
  const userLink = request.username ? `@${request.username}` : `ID: ${request.user_id}`;
  const date = new Date(request.created_at).toLocaleDateString('ru-RU');

  // Получаем список компаний для выбора
  const companies = Object.values(await db.getCompanies());

  const buttons = companies.map(c => [
    Markup.button.callback(`🏢 ${c.name}`, `approve_request_${requestId}_${c.id}`)
  ]);
  buttons.push([Markup.button.callback('❌ Отклонить', `reject_request_${requestId}`)]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin_requests')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📋 *Заявка*\n\n` +
    `👤 ${name}\n` +
    `📱 ${userLink}\n` +
    `🆔 \`${request.user_id}\`\n` +
    `📅 ${date}\n\n` +
    (companies.length > 0 ? 'Выберите компанию:' : '⚠️ Сначала создайте компанию'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^approve_request_(\d+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const requestId = parseInt(ctx.match[1]);
  const companyId = ctx.match[2];

  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const company = await db.getCompany(companyId);
  if (!company) {
    return ctx.answerCbQuery('Компания не найдена');
  }

  const name = [request.first_name, request.last_name].filter(Boolean).join(' ') || 'Пользователь';

  // Создаём пользователя
  await db.createUser(request.user_id, companyId, name);

  // Удаляем заявку
  await db.deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.user_id,
      `🎉 Ваша заявка одобрена!\n\n` +
      `🏢 Компания: ${company.name}\n\n` +
      `Отправьте /start чтобы начать.`
    );
  } catch (e) {}

  await ctx.answerCbQuery('Одобрено');

  // Возвращаемся к списку заявок
  const remainingRequests = await db.getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\n✅ Все заявки обработаны', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
      const tag = r.username ? `@${r.username}` : '';
      return [Markup.button.callback(`👤 ${n} ${tag}`, `view_request_${r.id}`)];
    });
    buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);
    await ctx.editMessageText(`📋 *Заявки на доступ (${remainingRequests.length})*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

bot.action(/^reject_request_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const requestId = parseInt(ctx.match[1]);
  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  // Удаляем заявку
  await db.deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.user_id, '❌ Ваша заявка на доступ отклонена.');
  } catch (e) {}

  await ctx.answerCbQuery('Отклонено');

  // Возвращаемся к списку заявок
  const remainingRequests = await db.getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
      const tag = r.username ? `@${r.username}` : '';
      return [Markup.button.callback(`👤 ${n} ${tag}`, `view_request_${r.id}`)];
    });
    buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);
    await ctx.editMessageText(`📋 *Заявки на доступ (${remainingRequests.length})*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

// ============ КОМПАНИИ ============

bot.action('admin_companies', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companies = Object.values(await db.getCompanies());

  const buttons = [];
  for (const c of companies.slice(0, 10)) {
    const users = await db.getCompanyUsers(c.id);
    const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
    buttons.push([Markup.button.callback(`🏢 ${c.name} (${users.length} чел, ${totalBalance}₽)`, `company_${c.id}`)]);
  }

  buttons.push([Markup.button.callback('➕ Добавить компанию', 'add_company')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('🏢 *Компании*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('add_company', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const state = getState(ctx.from.id);
  state.step = 'add_company_name';
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏢 *Новая компания*\n\nВведите название:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_companies')]]) }
  );
});

bot.action(/^company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
  const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);

  let text = `🏢 *${company.name}*\n\n`;
  text += `👥 Сотрудников: ${users.length}\n`;
  text += `💰 Общий баланс: ${totalBalance} ₽\n\n`;

  if (users.length > 0) {
    text += '*Сотрудники:*\n';
    users.forEach(u => {
      text += `• ${u.name || 'ID:' + u.id} — ${u.balance}₽\n`;
    });
  }

  const buttons = [
    [Markup.button.callback('➕ Добавить сотрудника', `add_user_${companyId}`)],
    [Markup.button.callback('💳 Пополнить баланс', `topup_company_${companyId}`)],
  ];

  if (users.length > 0) {
    buttons.push([Markup.button.callback('👥 Управление сотрудниками', `manage_users_${companyId}`)]);
    buttons.push([Markup.button.callback('📊 Отчёт по компании', `company_report_${companyId}`)]);
  }

  buttons.push([Markup.button.callback('✏️ Переименовать', `rename_company_${companyId}`)]);
  buttons.push([Markup.button.callback('🗑 Удалить компанию', `delete_company_${companyId}`)]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin_companies')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ============ ОТЧЁТ ПО КОМПАНИИ ============

bot.action(/^company_report_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
  const allGens = await db.getAllGenerations();
  const allTxs = await db.getAllTransactions();

  // Статистика по компании
  let totalGens = 0;
  let totalSpent = 0;
  let totalTopups = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.user_id == u.id);
    const userTxs = allTxs.filter(t => t.user_id == u.id);
    const spent = userGens.length * GENERATION_COST;
    const topups = userTxs.filter(t => t.type === 'topup').reduce((sum, t) => sum + t.amount, 0);

    totalGens += userGens.length;
    totalSpent += spent;
    totalTopups += topups;
    totalBalance += u.balance || 0;

    return {
      name: u.name || 'ID:' + u.id,
      balance: u.balance || 0,
      gens: userGens.length,
      spent,
      topups
    };
  });

  let text = `📊 *Отчёт: ${company.name}*\n\n`;
  text += `📅 Дата: ${new Date().toLocaleDateString('ru-RU')}\n\n`;
  text += `*Итого по компании:*\n`;
  text += `👥 Сотрудников: ${users.length}\n`;
  text += `🖼 Генераций: ${totalGens}\n`;
  text += `💸 Расходы: ${totalSpent} ₽\n`;
  text += `💰 Пополнения: ${totalTopups} ₽\n`;
  text += `💳 Остаток на счетах: ${totalBalance} ₽\n\n`;

  if (userStats.length > 0) {
    text += `*По сотрудникам:*\n`;
    userStats.sort((a, b) => b.gens - a.gens);
    userStats.forEach(u => {
      text += `• ${u.name}: ${u.gens} ген. (${u.spent}₽), баланс ${u.balance}₽\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📤 Отправить руководителю', `send_report_${companyId}`)],
      [Markup.button.callback('⬅️ Назад', `company_${companyId}`)]
    ])
  });
});

// Отправить отчёт руководителю (первому сотруднику компании или ввести ID)
bot.action(/^send_report_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);

  if (users.length === 0) {
    return ctx.answerCbQuery('Нет сотрудников');
  }

  const buttons = users.map(u => [
    Markup.button.callback(`📤 ${u.name || 'ID:' + u.id}`, `do_send_report_${companyId}_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_report_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('📤 *Выберите получателя отчёта:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^do_send_report_(.+)_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const recipientId = ctx.match[2];

  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
  const allGens = await db.getAllGenerations();
  const allTxs = await db.getAllTransactions();

  // Формируем отчёт
  let totalGens = 0;
  let totalSpent = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.user_id == u.id);
    const spent = userGens.length * GENERATION_COST;

    totalGens += userGens.length;
    totalSpent += spent;
    totalBalance += u.balance || 0;

    return {
      name: u.name || 'ID:' + u.id,
      balance: u.balance || 0,
      gens: userGens.length,
      spent
    };
  });

  let reportText = `📊 *Отчёт: ${company.name}*\n\n`;
  reportText += `📅 ${new Date().toLocaleDateString('ru-RU')}\n\n`;
  reportText += `*Итого:*\n`;
  reportText += `🖼 Генераций: ${totalGens}\n`;
  reportText += `💸 Расходы: ${totalSpent} ₽\n`;
  reportText += `💳 Остаток: ${totalBalance} ₽\n\n`;

  if (userStats.length > 0) {
    reportText += `*По сотрудникам:*\n`;
    userStats.sort((a, b) => b.gens - a.gens);
    userStats.forEach(u => {
      reportText += `• ${u.name}: ${u.gens} ген., ${u.spent}₽\n`;
    });
  }

  try {
    await bot.telegram.sendMessage(recipientId, reportText, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('Отчёт отправлен!');
    await ctx.editMessageText('✅ Отчёт отправлен!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    });
  } catch (e) {
    await ctx.answerCbQuery('Ошибка отправки');
    await ctx.editMessageText('❌ Не удалось отправить отчёт. Возможно, пользователь не начал диалог с ботом.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `company_report_${companyId}`)]])
    });
  }
});

// ============ ПЕРЕИМЕНОВАНИЕ КОМПАНИИ ============

bot.action(/^rename_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const state = getState(ctx.from.id);
  state.step = 'rename_company';
  state.tempData.renameCompanyId = companyId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `✏️ *Переименование компании*\n\nТекущее название: ${company.name}\n\nВведите новое название:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `company_${companyId}`)]]) }
  );
});

// ============ ДОБАВЛЕНИЕ СОТРУДНИКА ============

bot.action(/^add_user_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const state = getState(ctx.from.id);
  state.step = 'add_user_id';
  state.tempData.companyId = companyId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👤 *Добавить сотрудника*\n\n' +
    'Введите Telegram ID пользователя:\n\n' +
    '_Пользователь должен написать боту /start чтобы узнать свой ID, или перешлите сообщение от пользователя_',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `company_${companyId}`)]]) }
  );
});

// ============ УПРАВЛЕНИЕ СОТРУДНИКАМИ ============

bot.action(/^manage_users_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];

  // Проверка на валидность companyId
  if (!companyId || companyId === 'null' || companyId === 'undefined') {
    return ctx.answerCbQuery('Ошибка: компания не найдена');
  }

  const users = await db.getCompanyUsers(companyId);

  const buttons = users.map(u => [
    Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `user_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('👥 *Сотрудники*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const allGens = await db.getAllGenerations();
  const gens = allGens.filter(g => g.user_id == userId).length;

  await ctx.answerCbQuery();

  const buttons = [
    [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`)],
    [Markup.button.callback('🗑 Удалить', `delete_user_${userId}`)]
  ];

  // Кнопка "Назад" только если есть company_id
  if (user.company_id) {
    buttons.push([Markup.button.callback('⬅️ Назад', `manage_users_${user.company_id}`)]);
  } else {
    buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);
  }

  await ctx.editMessageText(
    `👤 *${escapeMarkdown(user.name) || 'ID:' + userId}*\n\n` +
    `💰 Баланс: ${user.balance} ₽\n` +
    `🖼 Генераций: ${gens}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companyId = user.company_id;
  await db.deleteUser(userId);

  await ctx.answerCbQuery('Удалён');

  // Возврат к списку сотрудников
  const users = await db.getCompanyUsers(companyId);
  if (users.length === 0) {
    // Если сотрудников не осталось, возвращаемся к компании
    const company = await db.getCompany(companyId);
    await ctx.editMessageText(`🏢 *${company?.name}*\n\nСотрудников нет`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить сотрудника', `add_user_${companyId}`)],
        [Markup.button.callback('⬅️ Назад', 'admin_companies')]
      ])
    });
  } else {
    const buttons = users.map(u => [
      Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `user_${u.id}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);
    await ctx.editMessageText('👥 *Сотрудники*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  }
});

// ============ ПОПОЛНЕНИЕ БАЛАНСА ============

bot.action(/^topup_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const users = await db.getCompanyUsers(companyId);

  if (users.length === 0) {
    return ctx.answerCbQuery('Нет сотрудников');
  }

  const buttons = users.map(u => [
    Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `topup_user_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('💳 *Выберите сотрудника:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^topup_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const state = getState(ctx.from.id);
  state.tempData.topupUserId = userId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💳 *Пополнение баланса*\n\n` +
    `👤 ${escapeMarkdown(user.name) || 'ID:' + userId}\n` +
    `💰 Текущий баланс: ${user.balance} ₽\n\n` +
    `Выберите сумму:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('300 ₽', 'do_topup_300'), Markup.button.callback('500 ₽', 'do_topup_500'), Markup.button.callback('1000 ₽', 'do_topup_1000')],
        [Markup.button.callback('2000 ₽', 'do_topup_2000'), Markup.button.callback('5000 ₽', 'do_topup_5000'), Markup.button.callback('10000 ₽', 'do_topup_10000')],
        [Markup.button.callback('⬅️ Назад', `user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_topup_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const state = getState(ctx.from.id);
  const amount = parseInt(ctx.match[1]);
  const userId = state.tempData.topupUserId;

  if (!userId) return ctx.answerCbQuery('Ошибка');

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  await db.updateUser(userId, { balance: (user.balance || 0) + amount });
  await db.addTransaction(userId, amount, 'topup', 'Пополнение администратором');

  try {
    await bot.telegram.sendMessage(userId, `💰 Ваш баланс пополнен на ${amount} ₽\n\nТекущий баланс: ${user.balance + amount} ₽`);
  } catch (e) {}

  state.tempData = {};

  await ctx.answerCbQuery(`Пополнено на ${amount} ₽`);
  await ctx.editMessageText(`✅ Баланс пополнен на ${amount} ₽`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компаниям', 'admin_companies')]])
  });
});

// ============ УДАЛЕНИЕ КОМПАНИИ ============

bot.action(/^delete_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const company = await db.getCompany(companyId);
  const users = await db.getCompanyUsers(companyId);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🗑 *Удалить компанию "${company?.name}"?*\n\n` +
    `⚠️ Будут удалены ${users.length} сотрудников!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', `confirm_delete_company_${companyId}`)],
        [Markup.button.callback('❌ Отмена', `company_${companyId}`)]
      ])
    }
  );
});

bot.action(/^confirm_delete_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const companyId = ctx.match[1];
  const users = await db.getCompanyUsers(companyId);

  // Удаляем всех сотрудников
  for (const u of users) {
    await db.deleteUser(u.id);
  }
  // Удаляем компанию
  await db.deleteCompany(companyId);

  await ctx.answerCbQuery('Компания удалена');

  // Возврат к списку компаний
  const companies = Object.values(await db.getCompanies());
  const buttons = [];
  for (const c of companies.slice(0, 10)) {
    const cUsers = await db.getCompanyUsers(c.id);
    const totalBalance = cUsers.reduce((sum, u) => sum + (u.balance || 0), 0);
    buttons.push([Markup.button.callback(`🏢 ${c.name} (${cUsers.length} чел, ${totalBalance}₽)`, `company_${c.id}`)]);
  }
  buttons.push([Markup.button.callback('➕ Добавить компанию', 'add_company')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.editMessageText('🏢 *Компании*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ============ СТАТИСТИКА ============

bot.action('admin_stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const stats = await db.getStats();
  const allTransactions = await db.getAllTransactions();
  const totalRevenue = allTransactions
    .filter(t => t.type === 'topup')
    .reduce((sum, t) => sum + t.amount, 0);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📊 *Статистика*\n\n' +
    '*Сегодня:*\n' +
    `🖼 Генераций: ${stats.today_generations}\n` +
    `💰 Пополнений: ${stats.today_topups} ₽\n\n` +
    '*Всего:*\n' +
    `🖼 Генераций: ${stats.generations_count}\n` +
    `💰 Пополнений: ${totalRevenue} ₽`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    }
  );
});

// ============ РАСХОДЫ API (REPLICATE) ============

bot.action('admin_api_costs', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  try {
    const costStats = await db.getCostStats(30);
    const dailyStats = await db.getDailyCostStats(7);

    let text = '💵 *Расходы API Replicate*\n\n';
    text += `📅 Период: ${costStats.period_days} дней\n`;
    text += `💱 Курс USD: ${costStats.cbr_rate} ₽\n\n`;

    text += '*📊 Сегодня:*\n';
    text += `├ 🖼 Генераций: ${costStats.today.generations}\n`;
    text += `├ 💰 Выручка: ${costStats.today.revenue_rub} ₽\n`;
    text += `├ 💸 Себестоимость: $${costStats.today.cost_usd} (${costStats.today.cost_rub} ₽)\n`;
    text += `└ 📈 Прибыль: ${costStats.today.profit_rub} ₽\n\n`;

    text += '*📊 За период:*\n';
    text += `├ 🖼 Генераций: ${costStats.total.generations}\n`;
    text += `├ 💰 Выручка: ${costStats.total.revenue_rub} ₽\n`;
    text += `├ 💸 Себестоимость: $${costStats.total.cost_usd} (${costStats.total.cost_rub} ₽)\n`;
    text += `├ 📈 Прибыль: ${costStats.total.profit_rub} ₽\n`;
    text += `└ 📊 Маржа: ${costStats.total.margin_percent}%\n\n`;

    if (dailyStats.length > 0) {
      text += '*📆 По дням (последние 7):*\n';
      for (const day of dailyStats.slice(0, 7)) {
        const dateStr = new Date(day.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        text += `${dateStr}: ${day.generations} шт, +${day.revenue_rub}₽, -$${day.cost_usd}, =${day.profit_rub}₽\n`;
      }
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } catch (e) {
    console.error('admin_api_costs error:', e);
    await ctx.answerCbQuery('Ошибка загрузки статистики');
  }
});

// ============ ВИЗУАЛИЗАЦИЯ ============

bot.action('new_visual', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.answerCbQuery('Нет доступа');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();

  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(
      '📸 *Новая визуализация*\n\nОтправьте фото помещения',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_main')]]) }
    );
  } catch (e) {
    await ctx.reply(
      '📸 *Новая визуализация*\n\nОтправьте фото помещения',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_main')]]) }
    );
  }
});

bot.action('back_main', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = null;
  state.tempData = {};
  await ctx.answerCbQuery();

  const user = await db.getUser(userId);
  let text = '🏠 *Визуализация натяжных потолков*\n\n';

  const tips = [
    '💡 _Визуализация за 30 секунд — покажите клиенту прямо на встрече!_',
    '🚀 _Генерация потолка за секунды — удивите клиента!_',
    '💰 _Визуализация повышает конверсию — клиент видит результат до заказа_',
    '📸 _Фото → Визуализация → Продажа. Просто загрузите фото комнаты_',
    '🎯 _Клиент видит потолок на своём фото — легче продавать_',
    '🎨 _Покажите потолок до установки_'
  ];
  const disclaimer = tips[Math.floor(Math.random() * tips.length)];

  if (isAdmin(userId)) {
    text += '👑 Вы администратор\n\n';
    text += disclaimer;
  } else if (user) {
    const company = await db.getCompany(user.company_id);
    text += `🏢 ${company?.name || 'Компания'}\n`;
    text += `💰 Баланс: ${user.balance} ₽\n\n`;
    text += disclaimer;
  }

  // Отправляем новое сообщение с постоянной клавиатурой
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...persistentKeyboard(isAdmin(userId), user)
  });
});

// ============ ЗАГРУЗКА ФОТО ============

bot.on('photo', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Обратитесь к администратору.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств. Нужно ${GENERATION_COST} ₽`,
      Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
    );
  }

  const state = getState(userId);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    state.photo = Buffer.from(resp.data);
    state.config = getDefaultConfig();

    await ctx.reply('✅ *Фото загружено*\n\n' + buildSummary(state.config), {
      parse_mode: 'Markdown',
      ...configMenu(state.config)
    });
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Ошибка загрузки фото');
  }
});

// ============ ОБРАБОТКА ТЕКСТА ============

bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text;

  // Добавление компании
  if (state.step === 'add_company_name' && isAdmin(userId)) {
    const company = await db.addCompany(text);
    state.step = null;

    return ctx.reply(`✅ Компания "${text}" создана`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить сотрудника', `add_user_${company.id}`)],
        [Markup.button.callback('⬅️ К компаниям', 'admin_companies')]
      ])
    );
  }

  // Переименование компании
  if (state.step === 'rename_company' && isAdmin(userId)) {
    const companyId = state.tempData.renameCompanyId;
    const newName = text.trim();

    await db.updateCompany(companyId, { name: newName });
    state.step = null;
    state.tempData = {};

    return ctx.reply(`✅ Компания переименована в "${newName}"`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    );
  }

  // Добавление сотрудника - ID
  if (state.step === 'add_user_id' && isAdmin(userId)) {
    const newUserId = text.trim();

    if (!/^\d+$/.test(newUserId)) {
      return ctx.reply('❌ ID должен содержать только цифры. Попробуйте снова:');
    }

    if (await db.getUser(newUserId)) {
      return ctx.reply('❌ Этот пользователь уже добавлен. Введите другой ID:');
    }

    state.tempData.newUserId = newUserId;
    state.step = 'add_user_name';

    return ctx.reply('👤 Введите имя сотрудника:');
  }

  // Добавление сотрудника - Имя
  if (state.step === 'add_user_name' && isAdmin(userId)) {
    const newUserId = state.tempData.newUserId;
    const companyId = state.tempData.companyId;
    const name = text.trim();

    await db.createUser(newUserId, companyId, name);

    state.step = null;
    state.tempData = {};

    try {
      const company = await db.getCompany(companyId);
      await bot.telegram.sendMessage(newUserId,
        `🎉 Вам предоставлен доступ к боту визуализации потолков!\n\n` +
        `🏢 Компания: ${company?.name}\n\n` +
        `Отправьте /start чтобы начать.`
      );
    } catch (e) {
      // Пользователь не начал диалог с ботом
    }

    return ctx.reply(`✅ Сотрудник "${name}" добавлен`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    );
  }

  // Добавление частника - ID
  if (state.step === 'add_individual_id' && isAdmin(userId)) {
    const newUserId = text.trim();

    if (!/^\d+$/.test(newUserId)) {
      return ctx.reply('❌ ID должен содержать только цифры. Попробуйте снова:');
    }

    if (await db.getUser(newUserId)) {
      return ctx.reply('❌ Этот пользователь уже зарегистрирован.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ К частникам', 'admin_individuals')]])
      );
    }

    state.tempData.newIndividualId = newUserId;
    state.step = 'add_individual_name';

    return ctx.reply('👤 Введите имя пользователя:');
  }

  // Добавление частника - Имя
  if (state.step === 'add_individual_name' && isAdmin(userId)) {
    const newUserId = state.tempData.newIndividualId;
    const name = text.trim();

    await db.registerIndividual(newUserId, name, null);

    state.step = null;
    state.tempData = {};

    try {
      await bot.telegram.sendMessage(newUserId,
        `🎉 Вам предоставлен доступ к боту визуализации потолков!\n\n` +
        `Отправьте /start чтобы начать.`
      );
    } catch (e) {
      // Пользователь не начал диалог с ботом
    }

    return ctx.reply(`✅ Частный пользователь "${name}" добавлен`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ К частникам', 'admin_individuals')]])
    );
  }

  // Сохранение избранной конфигурации
  if (state.step === 'save_favorite_name') {
    const name = text.trim().slice(0, 50); // ограничим 50 символами

    await db.addFavorite(userId, name, state.config);
    state.step = null;

    return ctx.reply(
      `✅ Конфигурация "${name}" сохранена в избранное!`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⭐ Избранное', 'favorites')],
          [Markup.button.callback('⬅️ К настройкам', 'back_config')]
        ])
      }
    );
  }

  // Ввод произвольной суммы пополнения
  if (state.step === 'topup_custom_amount') {
    const amount = parseInt(text.trim());

    if (isNaN(amount) || amount < 150) {
      return ctx.reply(
        '❌ Минимальная сумма: 150₽\n\nВведите сумму ещё раз:',
        Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'topup_menu')]])
      );
    }

    if (amount % 150 !== 0) {
      const lower = Math.floor(amount / 150) * 150;
      const upper = lower + 150;
      return ctx.reply(
        `❌ Сумма должна быть кратна 150₽\n\nБлижайшие: ${lower}₽ или ${upper}₽\n\nВведите сумму ещё раз:`,
        Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'topup_menu')]])
      );
    }

    state.step = null;

    // Создаём платёж
    const payment = await db.createPayment(userId, amount, null, null, `Пополнение баланса ${amount}₽`);

    const result = await createYooKassaPayment(
      amount,
      `Визуализация потолков: ${amount}₽`,
      BOT_URL,
      { payment_id: payment.id, user_id: userId }
    );

    if (result.success) {
      await db.updatePaymentYookassa(payment.id, result.paymentId, result.status);

      const generations = Math.floor(amount / 150);
      return ctx.reply(
        `💳 *Оплата ${amount} ₽*\n\n` +
        `📊 Это ${generations} генераций\n\n` +
        'Нажмите кнопку ниже для оплаты.\n' +
        'После оплаты баланс пополнится автоматически.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('💳 Оплатить', result.confirmationUrl)],
            [Markup.button.callback('✅ Я оплатил', `check_payment:${payment.id}`)],
            [Markup.button.callback('❌ Отмена', 'back_main')]
          ])
        }
      );
    } else {
      console.error('YooKassa error:', result.error);
      return ctx.reply(
        '❌ Ошибка создания платежа. Попробуйте позже.',
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Назад', 'back_main')]])
      );
    }
  }
  return next();
});

// Обработка пересланных сообщений для получения ID
bot.on('forward', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);

  if (state.step === 'add_user_id' && isAdmin(userId) && ctx.message.forward_from) {
    const forwardedUserId = ctx.message.forward_from.id.toString();

    if (await db.getUser(forwardedUserId)) {
      return ctx.reply('❌ Этот пользователь уже добавлен.');
    }

    state.tempData.newUserId = forwardedUserId;
    state.step = 'add_user_name';

    const forwardedName = ctx.message.forward_from.first_name || '';
    return ctx.reply(`👤 ID: ${forwardedUserId}\n\nВведите имя сотрудника (или оставьте "${forwardedName}"):`);
  }
});

// ============ ПРЕСЕТЫ ============

const PRESETS = {
  minimalism: {
    name: '🔲 Минимализм',
    description: 'Чистые линии, никаких излишеств',
    config: {
      color: 'white',
      texture: 'matte',
      profile: { back: 'shadow', front: 'shadow', left: 'shadow', right: 'shadow' },
      spots: { enabled: true, count: 4, type: 'round', color: 'white' },
      chandelier: { enabled: false, style: 'modern' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: false, count: 1, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  },
  classic: {
    name: '🏛 Классика',
    description: 'Элегантно с люстрой',
    config: {
      color: 'ivory',
      texture: 'satin',
      profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
      spots: { enabled: false, count: 6, type: 'round', color: 'gold' },
      chandelier: { enabled: true, style: 'classic' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: false, count: 1, color: 'white' },
      ledStrip: { enabled: true, color: 'warm' },
      niche: true,
      twoLevel: false
    }
  },
  premium: {
    name: '💎 Премиум',
    description: 'Двухуровневый с подсветкой',
    config: {
      color: 'white',
      texture: 'glossy',
      profile: { back: 'floating', front: 'floating', left: 'floating', right: 'floating' },
      spots: { enabled: true, count: 8, type: 'round', color: 'white' },
      chandelier: { enabled: true, style: 'ring' },
      lightlines: { enabled: false, count: 2, direction: 'along', shape: 'straight' },
      track: { enabled: false, count: 1, color: 'black' },
      ledStrip: { enabled: true, color: 'warm' },
      niche: true,
      twoLevel: true
    }
  },
  modern: {
    name: '✨ Современный',
    description: 'Световые линии и трек',
    config: {
      color: 'white',
      texture: 'matte',
      profile: { back: 'shadow', front: 'shadow', left: 'shadow', right: 'shadow' },
      spots: { enabled: false, count: 6, type: 'round', color: 'black' },
      chandelier: { enabled: false, style: 'minimalist' },
      lightlines: { enabled: true, count: 3, direction: 'along', shape: 'straight' },
      track: { enabled: true, count: 2, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  },
  loft: {
    name: '🏭 Лофт',
    description: 'Индустриальный стиль',
    config: {
      color: 'darkgray',
      texture: 'matte',
      profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
      spots: { enabled: false, count: 4, type: 'round', color: 'black' },
      chandelier: { enabled: true, style: 'industrial' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: true, count: 2, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  }
};

// ============ МЕНЮ КОНФИГУРАЦИИ ============

function configMenu(config) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚡ Пресеты', 'presets'), Markup.button.callback('⭐ Избранное', 'favorites')],
    [Markup.button.callback('🎨 Цвет', 'cfg_color'), Markup.button.callback('✨ Текстура', 'cfg_texture')],
    [Markup.button.callback('📐 Профили', 'cfg_profiles'), Markup.button.callback('🏗 Уровни', 'cfg_levels')],
    [Markup.button.callback('💡 Споты', 'cfg_spots'), Markup.button.callback('🪔 Люстра', 'cfg_chandelier')],
    [Markup.button.callback('📏 Линии', 'cfg_lightlines'), Markup.button.callback('🔦 Трек', 'cfg_track')],
    [Markup.button.callback('💫 LED', 'cfg_led'), Markup.button.callback('🪟 Ниша', 'cfg_niche')],
    [Markup.button.callback('✅ Сгенерировать', 'generate')],
    [Markup.button.callback('💾 Сохранить', 'save_favorite'), Markup.button.callback('🗑 Удалить', 'manage_favorites')],
    [Markup.button.callback('🔄 Сброс', 'reset'), Markup.button.callback('⬅️ Меню', 'back_main')]
  ]);
}

// Меню пресетов
bot.action('presets', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⚡ *Быстрые пресеты*\n\n' +
    'Выберите готовый стиль потолка:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔲 Минимализм', 'preset_minimalism')],
        [Markup.button.callback('🏛 Классика', 'preset_classic')],
        [Markup.button.callback('💎 Премиум', 'preset_premium')],
        [Markup.button.callback('✨ Современный', 'preset_modern')],
        [Markup.button.callback('🏭 Лофт', 'preset_loft')],
        [Markup.button.callback('⬅️ Назад', 'back_config')]
      ])
    }
  );
});

bot.action(/^preset_(.+)$/, async ctx => {
  const presetKey = ctx.match[1];
  const preset = PRESETS[presetKey];

  if (!preset) {
    return ctx.answerCbQuery('Пресет не найден');
  }

  const state = getState(ctx.from.id);
  state.config = JSON.parse(JSON.stringify(preset.config));

  await ctx.answerCbQuery(`${preset.name} применён!`);
  await ctx.editMessageText(
    `✅ *${preset.name}*\n\n${preset.description}\n\n` + buildSummary(state.config),
    { parse_mode: 'Markdown', ...configMenu(state.config) }
  );
});

bot.action('reset', async ctx => {
  const state = getState(ctx.from.id);
  state.config = getDefaultConfig();
  await ctx.answerCbQuery('Сброшено');
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ИЗБРАННОЕ ============

bot.action('favorites', async ctx => {
  const userId = ctx.from.id;
  const favorites = await db.getFavorites(userId);

  await ctx.answerCbQuery();

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Избранные конфигурации*\n\n' +
      'У вас пока нет сохранённых конфигураций.\n\n' +
      '_Сохраните текущие настройки, нажав "Сохранить в избранное" в меню настроек._',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`⭐ ${fav.name}`, `load_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Избранные конфигурации*\n\n' +
    'Выберите конфигурацию для загрузки:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^load_fav_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const favId = parseInt(ctx.match[1]);
  const fav = await db.getFavorite(favId, userId);

  if (!fav) {
    return ctx.answerCbQuery('Конфигурация не найдена');
  }

  const state = getState(userId);
  const config = typeof fav.config === 'string' ? JSON.parse(fav.config) : fav.config;
  state.config = JSON.parse(JSON.stringify(config));

  await ctx.answerCbQuery(`${fav.name} загружена!`);
  await ctx.editMessageText(
    `✅ Загружена: *${fav.name}*\n\n` + buildSummary(state.config),
    { parse_mode: 'Markdown', ...configMenu(state.config) }
  );
});

bot.action('save_favorite', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = 'save_favorite_name';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⭐ *Сохранить в избранное*\n\n' +
    'Введите название для этой конфигурации:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_config')]])
    }
  );
});

bot.action('manage_favorites', async ctx => {
  const userId = ctx.from.id;
  const favorites = await db.getFavorites(userId);

  await ctx.answerCbQuery();

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Управление избранным*\n\nНет сохранённых конфигураций.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`🗑 ${fav.name}`, `del_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Управление избранным*\n\n' +
    'Нажмите для удаления:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^del_fav_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const favId = parseInt(ctx.match[1]);

  await db.deleteFavorite(favId, userId);
  await ctx.answerCbQuery('Удалено');

  // Обновляем список
  const favorites = await db.getFavorites(userId);

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Управление избранным*\n\nНет сохранённых конфигураций.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`🗑 ${fav.name}`, `del_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Управление избранным*\n\n' +
    'Нажмите для удаления:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// ============ ЦВЕТ ============

bot.action('cfg_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🎨 *Цвет потолка:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬜ Белый', 'color_white'), Markup.button.callback('🤍 Айвори', 'color_ivory')],
      [Markup.button.callback('🟨 Бежевый', 'color_beige'), Markup.button.callback('⬛ Серый', 'color_gray')],
      [Markup.button.callback('🖤 Тёмно-серый', 'color_darkgray'), Markup.button.callback('⚫ Чёрный', 'color_black')],
      [Markup.button.callback('🔵 Голубой', 'color_blue'), Markup.button.callback('🩷 Розовый', 'color_pink')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^color_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.color = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ТЕКСТУРА ============

bot.action('cfg_texture', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✨ *Текстура:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Матовый', 'texture_matte')],
      [Markup.button.callback('✨ Глянцевый', 'texture_glossy')],
      [Markup.button.callback('🌟 Сатин', 'texture_satin')],
      [Markup.button.callback('⚡ Металлик', 'texture_metallic')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^texture_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.texture = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ПРОФИЛИ ============

bot.action('cfg_profiles', async ctx => {
  const state = getState(ctx.from.id);
  const p = state.config.profile;
  const icon = (v) => v === 'shadow' ? '🔲' : v === 'floating' ? '💫' : '➖';

  await ctx.answerCbQuery();
  await ctx.editMessageText('📐 *Профили по стенам:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`⬆️ Зад: ${icon(p.back)}`, 'profile_back')],
      [Markup.button.callback(`⬇️ Перед: ${icon(p.front)}`, 'profile_front')],
      [Markup.button.callback(`⬅️ Лево: ${icon(p.left)}`, 'profile_left')],
      [Markup.button.callback(`➡️ Право: ${icon(p.right)}`, 'profile_right')],
      [Markup.button.callback('🔲 Все теневые', 'profile_all_shadow')],
      [Markup.button.callback('💫 Все парящие', 'profile_all_floating')],
      [Markup.button.callback('➖ Все обычные', 'profile_all_none')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^profile_(back|front|left|right)$/, async ctx => {
  const wall = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`📐 *${wall === 'back' ? 'Задняя' : wall === 'front' ? 'Передняя' : wall === 'left' ? 'Левая' : 'Правая'} стена:*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➖ Обычный', `setprofile_${wall}_none`)],
      [Markup.button.callback('🔲 Теневой', `setprofile_${wall}_shadow`)],
      [Markup.button.callback('💫 Парящий', `setprofile_${wall}_floating`)],
      [Markup.button.callback('⬅️ Назад', 'cfg_profiles')]
    ])
  });
});

bot.action(/^setprofile_(.+)_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.profile[ctx.match[1]] = ctx.match[2];
  await ctx.answerCbQuery();

  const p = state.config.profile;
  const icon = (v) => v === 'shadow' ? '🔲' : v === 'floating' ? '💫' : '➖';
  await ctx.editMessageText('📐 *Профили по стенам:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`⬆️ Зад: ${icon(p.back)}`, 'profile_back')],
      [Markup.button.callback(`⬇️ Перед: ${icon(p.front)}`, 'profile_front')],
      [Markup.button.callback(`⬅️ Лево: ${icon(p.left)}`, 'profile_left')],
      [Markup.button.callback(`➡️ Право: ${icon(p.right)}`, 'profile_right')],
      [Markup.button.callback('🔲 Все теневые', 'profile_all_shadow')],
      [Markup.button.callback('💫 Все парящие', 'profile_all_floating')],
      [Markup.button.callback('➖ Все обычные', 'profile_all_none')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^profile_all_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  const value = ctx.match[1];
  state.config.profile = { back: value, front: value, left: value, right: value };
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ УРОВНИ ============

bot.action('cfg_levels', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏗 *Конструкция:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.twoLevel ? '✅ Двухуровневый' : '⬜ Двухуровневый', 'toggle_twolevel')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action('toggle_twolevel', async ctx => {
  const state = getState(ctx.from.id);
  state.config.twoLevel = !state.config.twoLevel;
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏗 *Конструкция:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.twoLevel ? '✅ Двухуровневый' : '⬜ Двухуровневый', 'toggle_twolevel')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

// ============ СПОТЫ ============

bot.action('cfg_spots', async ctx => {
  const state = getState(ctx.from.id);
  const s = state.config.spots;
  await ctx.answerCbQuery();

  const buttons = [
    [Markup.button.callback(s.enabled ? '🔴 Выключить' : '🟢 Включить', 'spots_toggle')]
  ];

  if (s.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${s.count}`, 'spots_count')]);
    buttons.push([Markup.button.callback(`Форма: ${s.type}`, 'spots_type')]);
    buttons.push([Markup.button.callback(`Цвет: ${s.color}`, 'spots_color')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💡 *Точечные светильники:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('spots_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.enabled = !state.config.spots.enabled;
  await ctx.answerCbQuery();

  const s = state.config.spots;
  const buttons = [[Markup.button.callback(s.enabled ? '🔴 Выключить' : '🟢 Включить', 'spots_toggle')]];
  if (s.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${s.count}`, 'spots_count')]);
    buttons.push([Markup.button.callback(`Форма: ${s.type}`, 'spots_type')]);
    buttons.push([Markup.button.callback(`Цвет: ${s.color}`, 'spots_color')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💡 *Точечные светильники:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('spots_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Количество:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'scount_1'), Markup.button.callback('2', 'scount_2'), Markup.button.callback('4', 'scount_4')],
      [Markup.button.callback('6', 'scount_6'), Markup.button.callback('8', 'scount_8'), Markup.button.callback('10', 'scount_10')],
      [Markup.button.callback('12', 'scount_12'), Markup.button.callback('16', 'scount_16')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^scount_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('spots_type', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Форма:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⚪ Круглые', 'stype_round')],
      [Markup.button.callback('⬜ Квадратные', 'stype_square')],
      [Markup.button.callback('⚪⚪ Двойные', 'stype_double')],
      [Markup.button.callback('🔄 Поворотные', 'stype_gimbal')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^stype_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.type = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('spots_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Цвет корпуса:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬜ Белый', 'scolor_white'), Markup.button.callback('⬛ Чёрный', 'scolor_black')],
      [Markup.button.callback('🟡 Золото', 'scolor_gold'), Markup.button.callback('⚪ Хром', 'scolor_chrome')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^scolor_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.color = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ЛЮСТРА ============

bot.action('cfg_chandelier', async ctx => {
  const state = getState(ctx.from.id);
  const c = state.config.chandelier;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(c.enabled ? '🔴 Выключить' : '🟢 Включить', 'chand_toggle')]];
  if (c.enabled) {
    buttons.push([Markup.button.callback('🔘 Современная', 'chand_modern'), Markup.button.callback('🏛 Классика', 'chand_classic')]);
    buttons.push([Markup.button.callback('💎 Хрусталь', 'chand_crystal'), Markup.button.callback('➖ Минимализм', 'chand_minimalist')]);
    buttons.push([Markup.button.callback('✳️ Спутник', 'chand_sputnik'), Markup.button.callback('⭕ Кольцо', 'chand_ring')]);
    buttons.push([Markup.button.callback('🫧 Кластер', 'chand_cluster'), Markup.button.callback('🏭 Лофт', 'chand_industrial')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('🪔 *Люстра:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('chand_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.enabled = !state.config.chandelier.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^chand_(.+)$/, async ctx => {
  if (ctx.match[1] === 'toggle') return;
  const state = getState(ctx.from.id);
  state.config.chandelier.style = ctx.match[1];
  state.config.chandelier.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ СВЕТОВЫЕ ЛИНИИ ============

bot.action('cfg_lightlines', async ctx => {
  const state = getState(ctx.from.id);
  const l = state.config.lightlines;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(l.enabled ? '🔴 Выключить' : '🟢 Включить', 'll_toggle')]];
  if (l.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${l.count}`, 'll_count')]);
    buttons.push([Markup.button.callback(`Направление: ${l.direction}`, 'll_dir')]);
    buttons.push([Markup.button.callback(`Форма: ${l.shape}`, 'll_shape')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('📏 *Световые линии:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('ll_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.enabled = !state.config.lightlines.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Количество линий:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'llc_1'), Markup.button.callback('2', 'llc_2'), Markup.button.callback('3', 'llc_3')],
      [Markup.button.callback('4', 'llc_4'), Markup.button.callback('5', 'llc_5')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^llc_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_dir', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Направление:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('↔️ Вдоль', 'lld_along')],
      [Markup.button.callback('↕️ Поперёк', 'lld_across')],
      [Markup.button.callback('↗️ Диагональ', 'lld_diagonal')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^lld_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.direction = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_shape', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Форма линий:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➖ Прямые', 'lls_straight')],
      [Markup.button.callback('⬡ Геометрия', 'lls_geometric')],
      [Markup.button.callback('〰️ Изогнутые', 'lls_curved')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^lls_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.shape = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ТРЕК ============

bot.action('cfg_track', async ctx => {
  const state = getState(ctx.from.id);
  const t = state.config.track;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(t.enabled ? '🔴 Выключить' : '🟢 Включить', 'track_toggle')]];
  if (t.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${t.count}`, 'track_count')]);
    buttons.push([Markup.button.callback('⬛ Чёрный', 'track_black'), Markup.button.callback('⬜ Белый', 'track_white')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('🔦 *Трековая система:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('track_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.track.enabled = !state.config.track.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('track_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🔦 *Количество треков:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'tcount_1'), Markup.button.callback('2', 'tcount_2'), Markup.button.callback('3', 'tcount_3')],
      [Markup.button.callback('4', 'tcount_4'), Markup.button.callback('5', 'tcount_5')],
      [Markup.button.callback('⬅️ Назад', 'cfg_track')]
    ])
  });
});

bot.action(/^tcount_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.track.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^track_(black|white)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.track.color = ctx.match[1];
  state.config.track.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ LED ============

bot.action('cfg_led', async ctx => {
  const state = getState(ctx.from.id);
  const l = state.config.ledStrip;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(l.enabled ? '🔴 Выключить' : '🟢 Включить', 'led_toggle')]];
  if (l.enabled) {
    buttons.push([Markup.button.callback('🟡 Тёплый', 'led_warm'), Markup.button.callback('⚪ Холодный', 'led_cold')]);
    buttons.push([Markup.button.callback('🌈 RGB', 'led_rgb')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💫 *LED подсветка:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('led_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.ledStrip.enabled = !state.config.ledStrip.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^led_(warm|cold|rgb)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.ledStrip.color = ctx.match[1];
  state.config.ledStrip.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ НИША ============

bot.action('cfg_niche', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪟 *Ниша для штор:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.niche ? '✅ Есть' : '⬜ Добавить', 'toggle_niche')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action('toggle_niche', async ctx => {
  const state = getState(ctx.from.id);
  state.config.niche = !state.config.niche;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ НАВИГАЦИЯ ============

bot.action('back_config', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
  } catch (e) {
    await ctx.reply('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
  }
});

// ============ ГЕНЕРАЦИЯ ============

// Функция обновления статуса с прогрессом
async function updateProgress(ctx, msgId, step, total = 4) {
  const steps = [
    '📤 Загружаю фото...',
    '🎨 Анализирую помещение...',
    '✨ Генерирую потолок...',
    '🖼 Обрабатываю результат...'
  ];
  const progress = '▓'.repeat(step) + '░'.repeat(total - step);
  const text = `${steps[step - 1]}\n\n[${progress}] ${Math.round(step / total * 100)}%`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text);
  } catch (e) {}
}

// Сохранение последней генерации для перегенерации
function saveLastGeneration(userId, config, resultUrl) {
  const state = getState(userId);
  state.lastGeneration = {
    config: JSON.parse(JSON.stringify(config)),
    resultUrl,
    timestamp: Date.now()
  };
}

bot.action('generate', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const user = await db.getUser(userId);

  if (!state.photo) {
    return ctx.answerCbQuery('Сначала загрузите фото');
  }

  if (state.processing) {
    return ctx.answerCbQuery('Генерация уже запущена...');
  }

  // Проверка доступа (кроме админов)
  if (!isAdmin(userId)) {
    if (!user) return ctx.answerCbQuery('Нет доступа');
    if (user.blocked) return ctx.answerCbQuery('Ваш доступ заблокирован');
    if (user.balance < GENERATION_COST) {
      return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
    }
  }

  state.processing = true;
  state.processingStarted = Date.now();
  await ctx.answerCbQuery();

  const statusMsg = await ctx.reply('🎨 *Генерация запущена!*\n\n⏳ Обычно занимает 30-60 секунд.\nРезультат придёт автоматически.\n\n_Можете продолжать пользоваться ботом._', {
    parse_mode: 'Markdown'
  });

  try {
    // Подготовка изображения
    const resizedImage = await sharp(state.photo)
      .resize(1536, 1536, { fit: 'inside' })
      .jpeg({ quality: 95 })
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${resizedImage.toString('base64')}`;
    const prompt = buildPrompt(state.config);
    console.log(`[${userId}] Prompt: ${prompt}`);

    // Создаём prediction с webhook (НЕ ждём результат)
    const prediction = await replicate.predictions.create({
      model: "google/nano-banana-pro",
      input: {
        prompt,
        image_input: [base64Image],
        resolution: "2K",
        aspect_ratio: "match_input_image",
        output_format: "jpg",
        safety_filter_level: "block_only_high"
      },
      webhook: WEBHOOK_URL,
      webhook_events_filter: ["completed"]
    });

    console.log(`[${userId}] Prediction created: ${prediction.id}`);

    // Сохраняем в БД для обработки webhook'ом
    await db.createPendingGeneration(
      prediction.id,
      userId,
      ctx.chat.id,
      statusMsg.message_id,
      state.config,
      state.photo
    );

  } catch (e) {
    console.error(`[${userId}] Error starting generation:`, e.message || e);
    state.processing = false;
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply('❌ Ошибка запуска генерации. Попробуйте снова.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'generate')],
        [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    );
  }
  // НЕ сбрасываем state.processing здесь - это сделает webhook
});

// Перегенерация с теми же настройками
bot.action('regenerate', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const user = await db.getUser(userId);

  if (!state.photo) {
    await ctx.answerCbQuery();
    return ctx.reply(
      '📸 *Фото не найдено*\n\n' +
      'Для перегенерации нужно загрузить фото заново.\n' +
      '_Это происходит после перезапуска бота или долгого перерыва._',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📸 Загрузить фото', 'new_visual')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      }
    );
  }

  if (state.processing) {
    return ctx.answerCbQuery('Генерация уже запущена...');
  }

  // Проверка доступа
  if (!isAdmin(userId)) {
    if (!user) return ctx.answerCbQuery('Нет доступа');
    if (user.balance < GENERATION_COST) {
      return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
    }
  }

  state.processing = true;
  state.processingStarted = Date.now();
  await ctx.answerCbQuery('Генерирую новый вариант...');

  const statusMsg = await ctx.reply('🎨 *Перегенерация запущена!*\n\n⏳ Обычно занимает 30-60 секунд.\nРезультат придёт автоматически.', {
    parse_mode: 'Markdown'
  });

  try {
    const resizedImage = await sharp(state.photo)
      .resize(1536, 1536, { fit: 'inside' })
      .jpeg({ quality: 95 })
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${resizedImage.toString('base64')}`;
    const prompt = buildPrompt(state.config);

    // Создаём prediction с webhook
    const prediction = await replicate.predictions.create({
      model: "google/nano-banana-pro",
      input: {
        prompt,
        image_input: [base64Image],
        resolution: "2K",
        aspect_ratio: "match_input_image",
        output_format: "jpg",
        safety_filter_level: "block_only_high"
      },
      webhook: WEBHOOK_URL,
      webhook_events_filter: ["completed"]
    });

    console.log(`[${userId}] Regenerate prediction created: ${prediction.id}`);

    await db.createPendingGeneration(
      prediction.id,
      userId,
      ctx.chat.id,
      statusMsg.message_id,
      state.config,
      state.photo
    );

  } catch (e) {
    console.error(`[${userId}] Regenerate error:`, e.message || e);
    state.processing = false;
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply('❌ Ошибка. Попробуйте снова.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'regenerate')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    );
  }
});

// ============ РЕГИСТРАЦИЯ (v2.0) ============

// Регистрация как частный пользователь
bot.action('register_individual', async ctx => {
  const userId = ctx.from.id;
  const name = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
  const username = ctx.from.username;

  try {
    const user = await db.registerIndividual(userId, name, username);
    await ctx.answerCbQuery('✅ Регистрация успешна!');
    await ctx.editMessageText(
      '✅ *Регистрация завершена!*\n\n' +
      `👤 ${escapeMarkdown(user.name)}\n` +
      `💰 Баланс: 0 ₽\n\n` +
      'Пополните баланс, чтобы начать использовать визуализации.\n' +
      '_Стоимость: 150₽ за генерацию_',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💳 Пополнить баланс', 'topup_menu')],
          [Markup.button.callback('🏠 Главное меню', 'back_main')]
        ])
      }
    );
  } catch (e) {
    console.error('register_individual error:', e);
    await ctx.answerCbQuery('Ошибка регистрации');
  }
});

// Начало регистрации компании
bot.action('register_company', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = 'company_name';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏢 *Регистрация компании*\n\n' +
    'Введите название вашей компании:',
    { parse_mode: 'Markdown' }
  );
});


// Присоединение к компании по коду
bot.action('join_company', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = 'join_company_code';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👥 *Присоединение к компании*\n\n' +
    'Введите код компании, который вам дал руководитель.\n\n' +
    '_Пример кода: CA4925_',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_registration')]])
    }
  );
});

// Обработка ввода названия компании
bot.on('text', async (ctx, next) => {
  console.log("🔍 Text handler called, userId:", ctx.from.id, "text:", ctx.message.text.substring(0, 50));
  const userId = ctx.from.id;
  const state = getState(userId);

  console.log('📝 Text handler: step =', state.step, 'text =', ctx.message.text);

  // Автоопределение кода компании (если пользователь не зарегистрирован)
  const text = ctx.message.text.trim();
  const codePattern = /^[A-Z0-9]{6}$/i;

  if (codePattern.test(text)) {
    const user = await db.getUser(userId);

    if (!user) {
      const code = text.toUpperCase();
      const company = await db.getCompanyByInviteCode(code);

      if (company) {
        // Регистрируем как сотрудника
        const name = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
        const username = ctx.from.username;

        try {
          await db.registerEmployee(userId, name, username, company.id);
          state.step = null;

          return await ctx.reply(
            '✅ *Регистрация завершена!*\n\n' +
            `🏢 Компания: *${company.name}*\n` +
            `👤 ${name}\n` +
            `💰 Баланс: 0 ₽\n\n` +
            'Пополните баланс, чтобы начать использовать визуализации.\n' +
            '_Стоимость: 150₽ за генерацию_',
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 Пополнить баланс', 'topup_menu')],
                [Markup.button.callback('🏠 Главное меню', 'back_main')]
              ])
            }
          );
        } catch (e) {
          console.error('auto join_company error:', e);
          return await ctx.reply('❌ Ошибка при регистрации. Попробуйте еще раз или нажмите /start');
        }
      }
    }
  }

  // Обработка ввода кода компании (обычный flow)
  if (state.step === 'join_company_code') {
    const code = ctx.message.text.trim().toUpperCase();

    // Ищем компанию по коду
    const company = await db.getCompanyByInviteCode(code);

    if (!company) {
      return ctx.reply('❌ Компания с таким кодом не найдена.\n\nПроверьте код и попробуйте еще раз или нажмите /start для отмены.');
    }

    // Регистрируем как сотрудника
    const name = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
    const username = ctx.from.username;

    try {
      const user = await db.registerEmployee(userId, name, username, company.id);
      state.step = null;

      await ctx.reply(
        '✅ *Регистрация завершена!*\n\n' +
        `🏢 Компания: *${company.name}*\n` +
        `👤 ${name}\n` +
        `💰 Баланс: 0 ₽\n\n` +
        'Пополните баланс, чтобы начать использовать визуализации.\n' +
        '_Стоимость: 150₽ за генерацию_',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💳 Пополнить баланс', 'topup_menu')],
            [Markup.button.callback('🏠 Главное меню', 'back_main')]
          ])
        }
      );
    } catch (e) {
      console.error('join_company error:', e);
      await ctx.reply('❌ Ошибка при регистрации. Попробуйте еще раз.');
    }
    return;
  }
  
  // Ввод сумм для распределения
  if (state.step === 'distribute_custom_amounts') {
    const amount = parseInt(ctx.message.text.trim());

    if (isNaN(amount) || amount < 0) {
      return ctx.reply('❌ Введите корректное число (или 0 для пропуска)');
    }

    if (amount % 150 !== 0) {
      return ctx.reply('❌ Сумма должна быть кратна 150₽');
    }

    const { employees, distributions, currentIndex, companyId } = state.tempData;
    const currentEmp = employees[currentIndex];

    // Сохраняем сумму для текущего сотрудника
    if (amount > 0) {
      distributions[currentEmp.id] = amount;
    }

    // Проверяем, есть ли еще сотрудники
    if (currentIndex + 1 < employees.length) {
      // Переходим к следующему сотруднику
      state.tempData.currentIndex++;
      const nextEmp = employees[state.tempData.currentIndex];
      const empName = nextEmp.name || nextEmp.username || nextEmp.id;

      const totalAllocated = Object.values(distributions).reduce((sum, val) => sum + val, 0);
      const company = await db.getCompanyByOwner(userId);
      const remaining = company.shared_balance - totalAllocated;

      return ctx.reply(
        `💸 *Распределение баланса*\n\n` +
        `🏦 Доступно: ${remaining} ₽\n` +
        `📊 Уже распределено: ${totalAllocated} ₽\n\n` +
        `👤 Сотрудник: *${empName}*\n` +
        `Текущий баланс: ${nextEmp.balance} ₽\n\n` +
        `Введите сумму для этого сотрудника (кратно 150) или 0 для пропуска:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_distribute')]])
        }
      );
    }

    // Все сотрудники обработаны - показываем подтверждение
    const totalAllocated = Object.values(distributions).reduce((sum, val) => sum + val, 0);
    
    if (totalAllocated === 0) {
      state.step = null;
      state.tempData = {};
      return ctx.reply('❌ Не указано ни одной суммы для распределения',
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      );
    }

    const company = await db.getCompanyByOwner(userId);

    if (totalAllocated > company.shared_balance) {
      state.step = null;
      state.tempData = {};
      return ctx.reply(`❌ Недостаточно средств. Доступно: ${company.shared_balance} ₽, указано: ${totalAllocated} ₽`,
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      );
    }

    // Формируем текст подтверждения
    let confirmText = `✅ *Подтверждение распределения*\n\n`;
    for (const empId in distributions) {
      const emp = employees.find(e => e.id == empId);
      const empName = emp.name || emp.username || emp.id;
      confirmText += `👤 ${empName}: ${distributions[empId]} ₽\n`;
    }
    confirmText += `\n💰 Итого: ${totalAllocated} ₽`;
    confirmText += `\n🏦 Останется: ${company.shared_balance - totalAllocated} ₽\n\n`;
    confirmText += `Подтвердить распределение?`;

    state.step = 'confirm_custom_distribute';

    return ctx.reply(confirmText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Распределить', 'execute_custom_distribute')],
        [Markup.button.callback('❌ Отмена', 'cancel_distribute')]
      ])
    });
  }

  if (state.step === 'company_name') {
    const companyName = ctx.message.text.trim();
    if (companyName.length < 2 || companyName.length > 100) {
      return ctx.reply('❌ Название должно быть от 2 до 100 символов');
    }

    state.tempData.companyName = companyName;
    await finishCompanyRegistration(ctx, userId, state);
    return;
  }

  // Если не регистрация - передаём дальше
  return next();
});

async function finishCompanyRegistration(ctx, userId, state) {
  const name = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
  const username = ctx.from.username;

  try {
    const { user, company } = await db.registerCompanyOwner(
      userId,
      name,
      username,
      state.tempData.companyName,
      null
    );

    state.step = null;
    state.tempData = {};

    await ctx.reply(
      '✅ *Компания зарегистрирована!*\n\n' +
      `🏢 ${company.name}\n` +
      `👤 Владелец: ${user.name}\n\n` +
      '*Что вы можете делать:*\n' +
      '• Пополнять общий счёт компании\n' +
      '• Приглашать сотрудников\n' +
      '• Распределять баланс между сотрудниками\n' +
      '• Видеть статистику по каждому\n\n' +
      '_Стоимость генерации: 150₽_',
      {
        parse_mode: 'Markdown',
        ...persistentKeyboard(false, user)
      }
    );
  } catch (e) {
    console.error('finishCompanyRegistration error:', e);
    await ctx.reply('❌ Ошибка регистрации компании');
  }
}

// ============ ПОПОЛНЕНИЕ БАЛАНСА (v2.0) ============

bot.action('topup_menu', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Сначала зарегистрируйтесь');
  }

  await ctx.answerCbQuery();
  await showTopupMenu(ctx, user || { balance: 0, user_type: 'individual' });
});

// Алиас для pay_balance → topup_menu
bot.action('pay_balance', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Сначала зарегистрируйтесь');
  }

  await ctx.answerCbQuery();
  await showTopupMenu(ctx, user || { balance: 0, user_type: 'individual' });
});

async function showTopupMenu(ctx, user) {
  const isOwner = user.user_type === 'company_owner';

  let text = '💳 *Пополнение баланса*\n\n';
  text += `💰 Текущий баланс: ${user.balance} ₽\n`;

  if (isOwner) {
    const company = await db.getCompanyByOwner(user.id);
    text += `🏦 Общий счёт компании: ${company?.shared_balance || 0} ₽\n`;
  }

  text += '\n*Выберите сумму:*\n';
  text += '_1 генерация = 150₽_';

  const buttons = TOPUP_AMOUNTS.map(item =>
    [Markup.button.callback(item.label, `topup_amount:${item.amount}`)]
  );

  // Кнопка для ввода произвольной суммы
  buttons.push([Markup.button.callback('💵 Ввести сумму', 'topup_custom')]);

  if (isOwner) {
    buttons.push([Markup.button.callback('🏢 На счёт компании', 'topup_company')]);
  }

  buttons.push([Markup.button.callback('🏠 Назад', 'back_main')]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  } else {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

// Выбор суммы для личного пополнения
bot.action(/^topup_amount:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const amount = parseInt(ctx.match[1]);

  const payment = await db.createPayment(userId, amount, null, null, `Пополнение баланса ${amount}₽`);

  const result = await createYooKassaPayment(
    amount,
    `Визуализация потолков: ${amount}₽`,
    BOT_URL,
    { payment_id: payment.id, user_id: userId }
  );

  if (result.success) {
    await db.updatePaymentYookassa(payment.id, result.paymentId, result.status);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `💳 *Оплата ${amount} ₽*\n\n` +
      'Нажмите кнопку ниже для оплаты.\n' +
      'После оплаты баланс пополнится автоматически.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить', result.confirmationUrl)],
          [Markup.button.callback('✅ Я оплатил', `check_payment:${payment.id}`)],
          [Markup.button.callback('❌ Отмена', 'back_main')]
        ])
      }
    );
  } else {
    await ctx.answerCbQuery('Ошибка создания платежа');
    console.error('YooKassa error:', result.error);
  }
});

// Ввод произвольной суммы пополнения
bot.action('topup_custom', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);

  state.step = 'topup_custom_amount';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '💵 *Ввод суммы пополнения*\n\n' +
    'Введите сумму в рублях (кратную 150):\n\n' +
    '_Например: 150, 300, 450, 600..._\n' +
    '_Минимум: 150₽_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'topup_menu')]])
    }
  );
});

// Проверка статуса оплаты
bot.action(/^check_payment:(\d+)$/, async ctx => {
  const paymentId = parseInt(ctx.match[1]);

  const payment = await db.pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!payment.rows[0]) {
    return ctx.answerCbQuery('Платёж не найден');
  }

  const yookassaId = payment.rows[0].yookassa_payment_id;
  const status = await getYooKassaPaymentStatus(yookassaId);

  if (status.success && status.status === 'succeeded') {
    await db.updatePaymentYookassa(paymentId, yookassaId, 'succeeded', status.paymentMethod);
    await db.processSuccessfulPayment(paymentId);

    const user = await db.getUser(ctx.from.id);
    await ctx.answerCbQuery('✅ Оплата подтверждена!');
    await ctx.editMessageText(
      '✅ *Оплата успешна!*\n\n' +
      `💰 Новый баланс: ${user.balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      }
    );
  } else if (status.status === 'canceled') {
    await ctx.answerCbQuery('❌ Платёж отменён');
  } else {
    await ctx.answerCbQuery('⏳ Ожидание оплаты...');
  }
});

// Пополнение счёта компании
bot.action('topup_company', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (user?.user_type !== 'company_owner') {
    return ctx.answerCbQuery('Только для владельцев компаний');
  }

  const company = await db.getCompanyByOwner(userId);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🏢 *Пополнение счёта компании*\n\n` +
    `Компания: ${company.name}\n` +
    `Текущий общий счёт: ${company.shared_balance} ₽\n\n` +
    '*Выберите сумму:*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...TOPUP_AMOUNTS.map(item =>
          [Markup.button.callback(item.label, `topup_company_amount:${item.amount}`)]
        ),
        [Markup.button.callback('⬅️ Назад', 'topup_menu')]
      ])
    }
  );
});

bot.action(/^topup_company_amount:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const amount = parseInt(ctx.match[1]);
  const company = await db.getCompanyByOwner(userId);

  const payment = await db.createPayment(userId, amount, company.id, null, `Пополнение счёта компании ${amount}₽`);

  const result = await createYooKassaPayment(
    amount,
    `${company.name}: пополнение ${amount}₽`,
    BOT_URL,
    { payment_id: payment.id, user_id: userId, company_id: company.id }
  );

  if (result.success) {
    await db.updatePaymentYookassa(payment.id, result.paymentId, result.status);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🏢 *Оплата для компании ${amount} ₽*\n\n` +
      'Нажмите кнопку для оплаты.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить', result.confirmationUrl)],
          [Markup.button.callback('✅ Я оплатил', `check_payment:${payment.id}`)],
          [Markup.button.callback('❌ Отмена', 'back_main')]
        ])
      }
    );
  } else {
    await ctx.answerCbQuery('Ошибка создания платежа');
  }
});

// ============ УПРАВЛЕНИЕ КОМПАНИЕЙ (v2.0) ============

bot.hears('🏢 Моя компания', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user || !user.company_id) {
    return ctx.reply('❌ Вы не состоите в компании');
  }

  // Получаем компанию
  let company;
  if (user.user_type === 'company_owner') {
    company = await db.getCompanyByOwner(userId);
  } else {
    company = await db.getCompany(user.company_id);
  }

  let text = '';
  let buttons = [];

  // Для владельца показываем полную информацию
  if (user.user_type === 'company_owner') {
    const stats = await db.getCompanyStats(company.id);
    const employees = await db.getCompanyEmployeeStats(company.id);

    text = `🏢 *${company.name}*\n\n`;
    text += `🏦 Общий счёт: ${stats.shared_balance} ₽\n`;
    text += `👥 Сотрудников: ${stats.employees_count}\n`;
    text += `💰 Балансы сотрудников: ${stats.total_employee_balance} ₽\n`;
    text += `🖼 Генераций всего: ${stats.total_generations}\n`;
    text += `📅 Сегодня: ${stats.today_generations}\n\n`;

    if (employees.length > 0) {
      text += '*Сотрудники:*\n';
      for (const emp of employees) {
        const role = emp.user_type === 'company_owner' ? '👑' : '👤';
        text += `${role} ${emp.name || emp.username || emp.id}: ${emp.balance}₽, ${emp.total_generations} ген.\n`;
      }
    }

    buttons = [
      [Markup.button.callback('➕ Пригласить сотрудника', 'invite_employee')],
      [Markup.button.callback('💸 Распределить баланс', 'distribute_balance')],
      [Markup.button.callback('👑 Передать права', 'transfer_ownership')],
      [Markup.button.callback('🏠 Главное меню', 'back_main')]
    ];
  } else {
    // Для сотрудника показываем только свою информацию
    const userStats = await db.getUserStats(userId);

    text = `🏢 *Компания: ${company.name}*\n\n`;
    text += `👤 ${user.name || user.username || 'Вы'}\n`;
    text += `💰 Ваш баланс: ${user.balance} ₽\n\n`;
    text += `*Ваши генерации:*\n`;
    text += `├ Всего: ${userStats.total_generations}\n`;
    text += `├ Сегодня: ${userStats.today_generations}\n`;
    text += `└ Потрачено: ${userStats.total_spent} ₽\n`;

    buttons = [
      [Markup.button.callback('🏠 Главное меню', 'back_main')]
    ];
  }

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Приглашение сотрудника
bot.action('invite_employee', async ctx => {
  const userId = ctx.from.id;

  await ctx.answerCbQuery();
  
  // Получаем информацию о компании
  const company = await db.getCompanyByOwner(userId);
  
  if (!company) {
    return ctx.editMessageText('❌ Компания не найдена');
  }

  await ctx.editMessageText(
    '➕ <b>Приглашение сотрудников</b>\n\n' +
    '🔑 Код вашей компании: <code>' + company.invite_code + '</code>\n\n' +
    '📝 Инструкция для сотрудника:\n' +
    '1. Открыть бота @NPotolki_bot\n' +
    '2. Нажать "Регистрация"\n' +
    '3. Выбрать "👥 Присоединиться к компании"\n' +
    '4. Ввести код: <code>' + company.invite_code + '</code>\n\n' +
    '<i>Сотрудник автоматически добавится в компанию</i>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'back_main')]])
    }
  );
});


// Обработка приглашения (forward или ID)
// bot.on('forward', async (ctx, next) => {
//   const userId = ctx.from.id;
//   const state = getState(userId);
// 
//   if (state.step === 'invite_employee') {
//     const forwardFrom = ctx.message.forward_from;
//     if (!forwardFrom) {
//       return ctx.reply('❌ Не удалось получить ID пользователя. Попросите его разрешить пересылку или введите ID вручную.');
//     }
// 
//     await processInvite(ctx, userId, forwardFrom.id);
//     return;
//   }
// 
//   return next();
// });
// 
// Ввод ID для приглашения
// bot.hears(/^\d{5,15}$/, async (ctx, next) => {
//   const userId = ctx.from.id;
//   const state = getState(userId);
// 
//   if (state.step === 'invite_employee') {
//     const invitedId = parseInt(ctx.message.text);
//     await processInvite(ctx, userId, invitedId);
//     return;
//   }
// 
//   return next();
// });
// 
// async function processInvite(ctx, ownerId, invitedId) {
//   const state = getState(ownerId);
//   state.step = null;
// 
//   if (ownerId === invitedId) {
//     return ctx.reply('❌ Нельзя пригласить самого себя');
//   }
// 
//   const company = await db.getCompanyByOwner(ownerId);
// 
//   // Проверяем, не состоит ли уже в компании
//   const existingUser = await db.getUser(invitedId);
//   if (existingUser?.company_id) {
//     return ctx.reply('❌ Пользователь уже состоит в компании');
//   }
// 
//   const invite = await db.inviteToCompany(company.id, invitedId, ownerId);
//   if (!invite) {
//     return ctx.reply('❌ Приглашение уже отправлено этому пользователю');
//   }
// 
//   await ctx.reply(
//     `✅ Приглашение отправлено!\n\n` +
//     `Когда пользователь напишет боту /start, он увидит приглашение в компанию "${company.name}".`
//   );
// 
//   // Пытаемся отправить уведомление приглашённому
//   try {
//     await ctx.telegram.sendMessage(invitedId,
//       `📬 *Приглашение в компанию!*\n\n` +
//       `Вас приглашают присоединиться к компании "${company.name}".\n\n` +
//       `Нажмите /start чтобы принять или отклонить приглашение.`,
//       { parse_mode: 'Markdown' }
//     );
//   } catch (e) {
//     // Пользователь мог не начинать диалог с ботом
//   }
// }

// Распределение баланса
bot.action('distribute_balance', async ctx => {
  const userId = ctx.from.id;
  const company = await db.getCompanyByOwner(userId);
  const employees = await db.getCompanyUsers(company.id);

  if (employees.length === 0) {
    return ctx.answerCbQuery('В компании нет сотрудников');
  }

  if (company.shared_balance < 150) {
    return ctx.answerCbQuery('Недостаточно средств на общем счёте');
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💸 *Распределение баланса*\n\n` +
    `🏦 Общий счёт: ${company.shared_balance} ₽\n` +
    `👥 Сотрудников: ${employees.length}\n\n` +
    `*Выберите способ:*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚖️ Поровну всем', 'distribute_evenly')],
        [Markup.button.callback('📝 Указать суммы', 'distribute_custom')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

bot.action('distribute_evenly', async ctx => {
  const userId = ctx.from.id;
  const company = await db.getCompanyByOwner(userId);
  const employees = await db.getCompanyUsers(company.id);

  // Расчёт суммы на каждого (кратно 150)
  const perPerson = Math.floor(company.shared_balance / employees.length / 150) * 150;

  if (perPerson < 150) {
    return ctx.answerCbQuery('Недостаточно для равного распределения');
  }

  const totalToDistribute = perPerson * employees.length;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `⚖️ *Равное распределение*\n\n` +
    `Каждому из ${employees.length} сотрудников: ${perPerson} ₽\n` +
    `Итого: ${totalToDistribute} ₽\n` +
    `Останется: ${company.shared_balance - totalToDistribute} ₽\n\n` +
    `Подтвердить?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Распределить', `confirm_distribute:${perPerson}`)],
        [Markup.button.callback('❌ Отмена', 'back_main')]
      ])
    }
  );
});

bot.action(/^confirm_distribute:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const perPerson = parseInt(ctx.match[1]);
  const company = await db.getCompanyByOwner(userId);

  try {
    await db.distributeEvenly(company.id, userId, company.shared_balance);
    await ctx.answerCbQuery('✅ Баланс распределён!');

    const updatedCompany = await db.getCompanyByOwner(userId);
    await ctx.editMessageText(
      `✅ *Баланс распределён!*\n\n` +
      `🏦 Остаток на общем счёте: ${updatedCompany.shared_balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      }
    );
  } catch (e) {
    console.error('distribute error:', e);
    await ctx.answerCbQuery('Ошибка: ' + e.message);
  }
});

// Распределение баланса вручную (в разработке)
bot.action('distribute_custom', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const company = await db.getCompanyByOwner(userId);
  const employees = await db.getCompanyUsers(company.id);

  // Инициализируем состояние для распределения
  state.step = 'distribute_custom_amounts';
  state.tempData = {
    companyId: company.id,
    employees: employees,
    distributions: {},
    currentIndex: 0
  };

  // Показываем первого сотрудника
  const emp = employees[0];
  const empName = emp.name || emp.username || emp.id;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💸 *Распределение баланса*\n\n` +
    `🏦 Доступно: ${company.shared_balance} ₽\n\n` +
    `👤 Сотрудник: *${empName}*\n` +
    `Текущий баланс: ${emp.balance} ₽\n\n` +
    `Введите сумму для этого сотрудника (кратно 150) или 0 для пропуска:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_distribute')]])
    }
  );
});

// Отмена распределения
bot.action('cancel_distribute', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = null;
  state.tempData = {};

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '❌ Распределение отменено',
    Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
  );
});


// Показать всех пользователей (пагинация)
bot.action('admin_all_users_more', async ctx => {
  await ctx.answerCbQuery('🚧 Пагинация в разработке');
});

bot.action('admin_individuals_more', async ctx => {
  await ctx.answerCbQuery('🚧 Пагинация в разработке');
});

// Передача прав владельца
bot.action('transfer_ownership', async ctx => {
  const userId = ctx.from.id;
  const company = await db.getCompanyByOwner(userId);
  const employees = await db.getCompanyUsers(company.id);
  const otherEmployees = employees.filter(e => e.id !== userId);

  if (otherEmployees.length === 0) {
    return ctx.answerCbQuery('Нет сотрудников для передачи');
  }

  const buttons = otherEmployees.map(e =>
    [Markup.button.callback(`👤 ${e.name || e.username || e.id}`, `transfer_to:${e.id}`)]
  );
  buttons.push([Markup.button.callback('❌ Отмена', 'back_main')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `👑 *Передача прав владельца*\n\n` +
    `⚠️ Вы потеряете права владельца компании!\n\n` +
    `Выберите нового владельца:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^transfer_to:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const toUserId = parseInt(ctx.match[1]);
  const company = await db.getCompanyByOwner(userId);

  try {
    await db.requestOwnershipTransfer(company.id, userId, toUserId);

    await ctx.answerCbQuery('Запрос отправлен');
    await ctx.editMessageText(
      `✅ *Запрос на передачу отправлен*\n\n` +
      `Пользователь должен принять запрос.\n` +
      `После принятия он станет новым владельцем, а вы - сотрудником.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      }
    );

    // Уведомляем нового владельца
    try {
      await ctx.telegram.sendMessage(toUserId,
        `🔔 *Запрос на передачу прав!*\n\n` +
        `Вам предлагают стать владельцем компании "${company.name}".\n\n` +
        `Нажмите /start чтобы принять или отклонить.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {}
  } catch (e) {
    await ctx.answerCbQuery('Ошибка: ' + e.message);
  }
});

bot.action('execute_custom_distribute', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);

  if (!state.tempData || !state.tempData.distributions) {
    return ctx.answerCbQuery('Ошибка: данные не найдены');
  }

  const { distributions, companyId } = state.tempData;
  const company = await db.getCompanyByOwner(userId);

  try {
    // Выполняем распределение
    await db.distributeBalance(companyId, userId, distributions);

    state.step = null;
    state.tempData = {};

    await ctx.answerCbQuery('✅ Баланс распределён!');

    const totalDistributed = Object.values(distributions).reduce((sum, val) => sum + val, 0);
    
    await ctx.editMessageText(
      `✅ *Распределение выполнено!*\n\n` +
      `💸 Распределено: ${totalDistributed} ₽\n` +
      `🏦 Осталось на общем счёте: ${company.shared_balance - totalDistributed} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      }
    );
  } catch (e) {
    state.step = null;
    state.tempData = {};
    await ctx.answerCbQuery('Ошибка: ' + e.message);
  }
});


// ============ ПРИНЯТИЕ ПРИГЛАШЕНИЙ (v2.0) ============

bot.action(/^accept_invite:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const inviteId = parseInt(ctx.match[1]);

  try {
    await db.acceptInvite(inviteId, userId);
    const user = await db.getUser(userId);
    const company = await db.getCompany(user.company_id);

    await ctx.answerCbQuery('✅ Приглашение принято!');
    await ctx.editMessageText(
      `✅ *Вы присоединились к компании!*\n\n` +
      `🏢 ${company.name}\n` +
      `💰 Ваш баланс: ${user.balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
      }
    );
  } catch (e) {
    await ctx.answerCbQuery('Ошибка: ' + e.message);
  }
});

bot.action(/^decline_invite:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const inviteId = parseInt(ctx.match[1]);

  await db.declineInvite(inviteId, userId);
  await ctx.answerCbQuery('Приглашение отклонено');
  await ctx.editMessageText('❌ Приглашение отклонено', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
  });
});

// Принятие передачи прав
bot.action(/^accept_transfer:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const transferId = parseInt(ctx.match[1]);

  try {
    await db.acceptOwnershipTransfer(transferId, userId);
    const user = await db.getUser(userId);
    const company = await db.getCompanyByOwner(userId);

    await ctx.answerCbQuery('✅ Вы стали владельцем!');
    await ctx.editMessageText(
      `👑 *Вы стали владельцем компании!*\n\n` +
      `🏢 ${company.name}\n` +
      `🏦 Общий счёт: ${company.shared_balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...persistentKeyboard(false, user)
      }
    );
  } catch (e) {
    await ctx.answerCbQuery('Ошибка: ' + e.message);
  }
});

bot.action(/^decline_transfer:(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const transferId = parseInt(ctx.match[1]);

  await db.declineOwnershipTransfer(transferId, userId);
  await ctx.answerCbQuery('Запрос отклонён');
  await ctx.editMessageText('❌ Запрос на передачу прав отклонён', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
  });
});

// ============ СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ (v2.0) ============

bot.hears('📊 Статистика', async ctx => {
  const userId = ctx.from.id;
  const stats = await db.getUserStats(userId);

  if (!stats) {
    return ctx.reply('❌ Сначала зарегистрируйтесь: /start');
  }

  let text = `📊 *Ваша статистика*\n\n`;
  text += `👤 ${stats.name || 'Пользователь'}\n`;
  text += `💰 Баланс: ${stats.balance} ₽\n\n`;

  text += `*Генерации:*\n`;
  text += `├ Всего: ${stats.total_generations}\n`;
  text += `├ Сегодня: ${stats.today_generations}\n`;
  text += `└ Потрачено: ${stats.total_spent} ₽\n\n`;

  text += `*Пополнения:*\n`;
  text += `└ Всего: ${stats.total_topups} ₽\n`;

  if (stats.company_name) {
    text += `\n🏢 Компания: ${stats.company_name}\n`;
    if (stats.user_type === 'company_owner') {
      text += `🏦 Общий счёт: ${stats.company_balance} ₽`;
    }
  }

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'back_main')]])
  });
});

// ============ WEBHOOK ДЛЯ YOOKASSA ============

app.post('/yookassa-webhook', async (req, res) => {
  try {
    const data = parseYooKassaWebhook(req.body);
    if (!data) {
      return res.status(400).send('Invalid webhook');
    }

    console.log('YooKassa webhook:', data.event, data.paymentId);

    if (data.event === 'payment.succeeded') {
      const payment = await db.getPaymentByYookassaId(data.paymentId);
      if (payment && payment.yookassa_status !== 'succeeded') {
        await db.updatePaymentYookassa(payment.id, data.paymentId, 'succeeded');
        await db.processSuccessfulPayment(payment.id);
        console.log('Payment processed:', payment.id);
      }
    } else if (data.event === 'payment.canceled') {
      const payment = await db.getPaymentByYookassaId(data.paymentId);
      if (payment) {
        await db.updatePaymentYookassa(payment.id, data.paymentId, 'canceled');
      }
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).send('Error');
  }
});

// ============ WEBHOOK ДЛЯ REPLICATE ============

// Функция проверки Replicate webhook
function verifyReplicateWebhook(req) {
  // Если секрет не настроен - пропускаем проверку
  if (!WEBHOOK_SECRET) return true;

  // Проверяем секрет через query параметр в URL
  // (Replicate API не поддерживает webhook_secret, поэтому передаём секрет в URL)
  return req.query.secret === WEBHOOK_SECRET;
}

// Обработчик webhook (поддерживает оба пути)
async function handleReplicateWebhook(req, res) {
  try {
    // Проверка подписи
    if (!verifyReplicateWebhook(req)) {
      console.warn('[Replicate Webhook] Invalid signature');
      return res.status(401).send('Unauthorized');
    }

    const { id, status, output, error } = req.body;
    console.log(`[Replicate Webhook] ${id}: ${status}`);

    // Сразу отвечаем OK
    res.status(200).send('OK');

    // Находим pending generation
    const pending = await db.getPendingGeneration(id);
    if (!pending) {
      console.log(`[Replicate Webhook] Generation ${id} not found in DB`);
      return;
    }

    if (status === 'succeeded' && output) {
      // Успешная генерация
      const resultUrl = Array.isArray(output) ? output[0] : output;
      const userId = pending.user_id;
      const chatId = pending.chat_id;
      const config = typeof pending.config === 'string' ? JSON.parse(pending.config) : pending.config;

      // Получаем пользователя
      const user = await db.getUser(userId);

      // Списание (кроме админов)
      if (!isAdmin(userId) && user) {
        await db.updateUser(userId, { balance: (user.balance || 0) - GENERATION_COST });
        await db.addTransaction(userId, -GENERATION_COST, 'generation', 'Генерация визуализации');
      }

      // Сохраняем генерацию
      const costUsd = 0.15;
      await db.addGeneration(userId, config, resultUrl, costUsd);
      saveLastGeneration(userId, config, resultUrl);

      // Удаляем статусное сообщение
      if (pending.status_message_id) {
        await bot.telegram.deleteMessage(chatId, pending.status_message_id).catch(() => {});
      }

      const newBalance = isAdmin(userId) ? '∞' : ((user?.balance || 0) - GENERATION_COST);

      // Добавляем водяной знак и отправляем результат
      try {
        const watermarkedImage = await addWatermark(resultUrl);
        await bot.telegram.sendPhoto(chatId, { source: watermarkedImage }, {
          caption: '✅ *Готово!*\n\n' + buildSummary(config) +
            `\n\n💰 Баланс: ${newBalance} ₽` +
            '\n\n💡 _Покажите клиенту — пусть оценит будущий потолок!_',
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Перегенерировать (150₽)', 'regenerate')],
            [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
            [Markup.button.callback('📸 Новое фото', 'new_visual')],
            [Markup.button.callback('🏠 Меню', 'back_main')]
          ])
        });
      } catch (imgErr) {
        // Если не удалось добавить водяной знак, отправляем без него
        await bot.telegram.sendPhoto(chatId, resultUrl, {
          caption: '✅ *Готово!*\n\n' + buildSummary(config) +
            `\n\n💰 Баланс: ${newBalance} ₽`,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Перегенерировать (150₽)', 'regenerate')],
            [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
            [Markup.button.callback('📸 Новое фото', 'new_visual')],
            [Markup.button.callback('🏠 Меню', 'back_main')]
          ])
        });
      }

      console.log(`[${userId}] Done via webhook: ${resultUrl}`);

    } else if (status === 'failed') {
      // Ошибка генерации
      const chatId = pending.chat_id;

      if (pending.status_message_id) {
        await bot.telegram.deleteMessage(chatId, pending.status_message_id).catch(() => {});
      }

      await bot.telegram.sendMessage(chatId,
        '❌ Ошибка генерации. Попробуйте снова или выберите другие настройки.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Попробовать снова', 'generate')],
          [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      );

      console.error(`[${pending.user_id}] Generation failed: ${error}`);
    }

    // Удаляем из pending
    await db.deletePendingGeneration(id);

    // Сбрасываем флаг processing
    const state = getState(pending.user_id);
    if (state) {
      state.processing = false;
      state.processingStarted = null;
    }

  } catch (e) {
    console.error('Replicate webhook error:', e);
    // Пытаемся сбросить processing даже при ошибке
    try {
      const pending = await db.getPendingGeneration(id);
      if (pending) {
        const state = getState(pending.user_id);
        if (state) {
          state.processing = false;
          state.processingStarted = null;
        }
      }
    } catch (e2) {}
  }
}

// Регистрация обоих путей для webhook
// Универсальный обработчик webhook (Telegram + Replicate)
// Универсальный обработчик webhook (Telegram + Replicate)
// Replicate webhook handler (остается отдельно)
// Replicate webhook handler
app.post('/replicate-webhook', handleReplicateWebhook);

// Telegram webhook - прямой вызов handleUpdate
app.post('/potolki-webhook', async (req, res) => {
  console.log('📨 Telegram webhook, update_id:', req.body?.update_id);
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('❌ handleUpdate error:', err);
    res.sendStatus(500);
  }
});
// ============ ОБРАБОТКА ОШИБОК ============

// Глобальный обработчик ошибок бота
bot.catch((err, ctx) => {
  console.error(`Ошибка в обработчике [${ctx.updateType}]:`, err.message);
  try {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('Произошла ошибка, попробуйте ещё раз').catch(() => {});
    }
  } catch (e) {}
});

// Обработка необработанных Promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Обработка необработанных исключений
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ============ ЗАПУСК ============

const PORT = process.env.PORT || 3001;

// Настройка Telegram webhook для Telegraf
const WEBHOOK_DOMAIN = 'https://lanaaihelper.ru';
const WEBHOOK_PATH = '/potolki-webhook';


// Запуск Express сервера (для всех webhooks)
app.listen(PORT, async () => {
  console.log(`🌐 Express сервер запущен на порту ${PORT}`);
  
  // Запуск Telegram бота в webhook режиме
  console.log('⏳ Настройка Telegram webhook...');
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`, {
      drop_pending_updates: true
    });
    console.log(`✅ Telegram webhook установлен: ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
    
    // Проверка установки webhook
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('📋 Webhook info:', JSON.stringify(webhookInfo, null, 2));
  } catch (err) {
    console.error('❌ ОШИБКА настройки webhook:');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
  }
});

// Graceful shutdown
process.once('SIGINT', async () => {
  console.log('Получен SIGINT, останавливаем бота...');
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  console.log('Получен SIGTERM, останавливаем бота...');
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.stop('SIGTERM');
});
